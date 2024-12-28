const puppeteer = require('puppeteer')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const sizeOf = require('image-size')
const xml2js = require('xml2js')
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args))

/* --------------------- Globals --------------------- */
let isVerbose = false

/* --------------------- Helpers --------------------- */
function logDebug(...msg) {
    if (isVerbose) console.log(...msg)
}

function parseSizeThreshold(input) {
    if (!input) return 10240
    const match = input.match(/^(\d+)(k?)$/i)
    if (!match) return 10240
    const n = parseInt(match[1], 10)
    return match[2].toLowerCase() === 'k' ? n * 1024 : n
}

function parseOutputFolder(urlString) {
    try {
        const p = new URL(urlString).pathname.replace(/\/+$/, '')
        let folder = p.substring(p.lastIndexOf('/') + 1) || 'output'
        folder = folder.replace(/[^\w-]/g, '') || 'output'
        return folder
    } catch {
        return 'output'
    }
}

function getMediaDuration(ffprobePath, filePath) {
    try {
        return parseFloat(
            execSync(`${ffprobePath} -v error -select_streams v:0 -show_entries format=duration -of csv=p=0 "${filePath}"`)
                .toString().trim()
        )
    } catch {
        return 0
    }
}

/* --------------------- Filtering --------------------- */
function filterAndSaveMedia(folderName, resource, threshold) {
    if (resource.buf.length < threshold) {
        logDebug('Resource below threshold, skipping:', resource.url)
        return false
    }
    let baseName = path.basename(new URL(resource.url).pathname) || 'file'
    if (!/\.[a-zA-Z0-9]+$/.test(baseName)) {
        const ext = resource.ctype.split(';')[0].split('/')[1]
        if (ext) baseName += '.' + ext
    }
    if (Buffer.byteLength(baseName, 'utf8') > 128) {
        logDebug('Filename too long, skipping:', baseName)
        return false
    }
    if (resource.ctype.startsWith('image/')) {
        if (resource.ctype === 'image/png') {
            logDebug('Skipping PNG')
            return false
        }
        try {
            const dim = sizeOf(resource.buf)
            if (dim.width < 161 || dim.height < 161) {
                logDebug('Image dimension too small, skipping:', baseName)
                return false
            }
        } catch {
            return false
        }
    }
    fs.mkdirSync(folderName, { recursive: true })
    fs.writeFileSync(path.join(folderName, baseName), resource.buf)
    console.log('Saved file =>', baseName, resource.buf.length, 'bytes')
    return true
}

/* --------------------- Partial MP4 Combine --------------------- */
function combinePartialMp4Chunks(partialMp4s, folderName, threshold, mediaType) {
    const FILENAME_LIMIT = 256
    const results = []

    for (const [baseName, chunks] of Object.entries(partialMp4s)) {
        chunks.sort((a, b) => a.start - b.start)
        const combined = Buffer.concat(chunks.map(x => x.chunk))
        if (combined.length < threshold) {
            logDebug('Combined MP4 below threshold, skipping:', baseName)
            continue
        }
        if (!['video', 'any', 'mp4combine'].includes(mediaType)) continue

        const ext = path.extname(baseName) || '.mp4'
        const name = path.basename(baseName, ext)
        const fileName = name + ext
        if (Buffer.byteLength(fileName, 'utf8') > FILENAME_LIMIT) {
            logDebug('Output filename too long, skipping:', fileName)
            continue
        }

        fs.mkdirSync(folderName, { recursive: true })
        const outPath = path.join(folderName, fileName)
        fs.writeFileSync(outPath, combined)
        console.log('Saved file =>', fileName, combined.length, 'bytes')
        results.push(outPath)
    }
    return results
}

/* --------------------- Merge Video + Audio --------------------- */
function mergeVideoAndAudio(folderName, postName, ffmpegPath, ffprobePath) {
    const mp4List = fs.readdirSync(folderName)
        .filter(f => f.toLowerCase().endsWith('.mp4'))
        .map(f => {
            const fullPath = path.join(folderName, f)
            const stat = fs.statSync(fullPath)
            return { name: f, size: stat.size, fullPath }
        })
        .sort((a, b) => b.size - a.size)

    if (mp4List.length < 2) return

    const videoFile = mp4List[0]
    const audioFile = mp4List[1]
    const vidDur = getMediaDuration(ffprobePath, videoFile.fullPath)
    const audDur = getMediaDuration(ffprobePath, audioFile.fullPath)

    if (Math.abs(vidDur - audDur) < 0.5) {
        const finalOut = path.join(folderName, postName + '.mp4')
        try {
            execSync(`${ffmpegPath} -y -i "${videoFile.fullPath}" -i "${audioFile.fullPath}" -c copy -map 0:v:0 -map 1:a:0 "${finalOut}"`)
            const mergedStat = fs.statSync(finalOut)
            console.log('Merged final mp4 =>', path.basename(finalOut), mergedStat.size, 'bytes')
        } catch (e) {
            logDebug('ffmpeg merge failed', e)
        }
    }
}

/* --------------------- JSON Parsing --------------------- */
function findJsonItemWithOwner(jsonStr) {
    try {
        const obj = JSON.parse(jsonStr)
        return searchItemWithOwner(obj)
    } catch {
        return null
    }
}

function searchItemWithOwner(obj) {
    if (!obj || typeof obj !== 'object') return null
    if (obj.owner && obj.owner.username) return obj
    for (const k in obj) {
        const sub = searchItemWithOwner(obj[k])
        if (sub) return sub
    }
    return null
}

/* --------------------- DASH Downloads --------------------- */
async function downloadRange(url, start, end) {
    const headers = {}
    let rangeDesc = 'FULL'
    if (start !== undefined && end !== undefined) {
        headers.Range = `bytes=${start}-${end}`
        rangeDesc = `${start}-${end}`
    }
    logDebug(`[downloadRange] Requesting [${rangeDesc}] => ${url.substring(0, 100)}...`)
    const res = await fetch(url, { headers })
    logDebug(`[downloadRange] Response code: ${res.status}`)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)

    const buf = Buffer.from(await res.arrayBuffer())
    logDebug(`[downloadRange] Received chunk => ${buf.length} bytes for [${rangeDesc}]`)
    return buf
}

function parseByteRange(str) {
    const m = str.match(/^(\d+)-(\d+)$/)
    if (!m) return null
    return [parseInt(m[1], 10), parseInt(m[2], 10)]
}

async function downloadDashRepresentation(repr) {
    const baseURL = repr.BaseURL[0]
    const segBase = repr.SegmentBase[0]
    const id = repr.$.id

    logDebug(`\n[downloadDashRepresentation] Representation ID="${id}"`)
    const totalLen = parseInt(repr.$.FBContentLength || '0', 10)
    const initRangeStr = segBase.Initialization[0].$.range
    const initRange = parseByteRange(initRangeStr) || [0, 0]
    logDebug(`[downloadDashRepresentation] initRange=${initRangeStr}`)

    const initBuf = await downloadRange(baseURL, initRange[0], initRange[1])
    const chunks = [initBuf]

    if (totalLen > 0) {
        const startByte = initRange[1] + 1
        const endByte = totalLen - 1
        logDebug(`[downloadDashRepresentation] Download entire => ${startByte}-${endByte}`)
        const mainBuf = await downloadRange(baseURL, startByte, endByte)
        chunks.push(mainBuf)
    } else {
        const srA = segBase.$.FBFirstSegmentRange
        const srB = segBase.$.FBSecondSegmentRange
        const srP = segBase.$.FBPrefetchSegmentRange
        const segRanges = []
        if (srA) segRanges.push(srA)
        if (srB) segRanges.push(srB)
        if (srP && !segRanges.includes(srP)) segRanges.push(srP)
        for (const sr of segRanges) {
            const [s, e] = parseByteRange(sr)
            logDebug(`[downloadDashRepresentation] Download => ${sr}`)
            const segBuf = await downloadRange(baseURL, s, e)
            chunks.push(segBuf)
        }
    }

    const resultBuf = Buffer.concat(chunks)
    logDebug(`[downloadDashRepresentation] Combined => ${resultBuf.length} bytes for ID="${id}"`)
    return resultBuf
}

async function mergeDashVideoAudio(videoBuf, audioBuf, outPath = 'final.mp4') {
    fs.writeFileSync('temp_video.mp4', videoBuf)
    fs.writeFileSync('temp_audio.mp4', audioBuf)
    try {
        execSync(`ffmpeg -y -i temp_video.mp4 -i temp_audio.mp4 -c copy -map 0:v:0 -map 1:a:0 "${outPath}" > /dev/null 2>&1`)
        const mergedStat = fs.statSync(outPath)
        console.log('Merged final mp4 =>', outPath, mergedStat.size, 'bytes')
    } catch (e) {
        logDebug('[mergeDashVideoAudio] ffmpeg merge error:', e)
    } finally {
        try { fs.unlinkSync('temp_video.mp4') } catch { }
        try { fs.unlinkSync('temp_audio.mp4') } catch { }
    }
}

async function downloadBestQualityDash(mpdXml, folderName, postName) {
    logDebug('[downloadBestQualityDash] Parsing MPD XML')
    const parsed = await xml2js.parseStringPromise(mpdXml)
    const period = parsed.MPD.Period[0]
    const adaptationSets = period.AdaptationSet
    if (!Array.isArray(adaptationSets)) {
        logDebug('[downloadBestQualityDash] No adaptation sets array?')
        return
    }

    const videoSet = findVideoAdaptationSet(adaptationSets)
    const audioSet = findAudioAdaptationSet(adaptationSets)
    if (!videoSet) {
        logDebug('[downloadBestQualityDash] Could not find a video adaptation set.')
        return
    }
    if (!audioSet) {
        logDebug('[downloadBestQualityDash] Could not find an audio adaptation set.')
        return
    }

    const videoReprs = Array.isArray(videoSet.Representation) ? videoSet.Representation : [videoSet.Representation]
    const audioReprs = Array.isArray(audioSet.Representation) ? audioSet.Representation : [audioSet.Representation]

    videoReprs.sort((a, b) => parseInt(b.$.bandwidth || '0', 10) - parseInt(a.$.bandwidth || '0', 10))
    audioReprs.sort((a, b) => parseInt(b.$.bandwidth || '0', 10) - parseInt(a.$.bandwidth || '0', 10))

    const bestVideo = videoReprs[0]
    const bestAudio = audioReprs[0]

    console.log('Selected video =>', bestVideo.$.id, bestVideo.$.bandwidth)
    console.log('Selected audio =>', bestAudio.$.id, bestAudio.$.bandwidth)

    const videoBuf = await downloadDashRepresentation(bestVideo)
    const audioBuf = await downloadDashRepresentation(bestAudio)

    const finalPath = path.join(folderName, postName + '.mp4')
    await mergeDashVideoAudio(videoBuf, audioBuf, finalPath)
    console.log('Saved file =>', path.basename(finalPath))
}

/* --------------------- Identify Video/Audio AdaptationSets --------------------- */
function findVideoAdaptationSet(adaptationSets) {
    const direct = adaptationSets.find(a => (a.$.contentType || '').toLowerCase() === 'video')
    if (direct) return direct

    for (const a of adaptationSets) {
        if (!a.Representation) continue
        const reps = Array.isArray(a.Representation) ? a.Representation : [a.Representation]
        const r0 = reps[0].$
        if (r0 && r0.mimeType && r0.mimeType.includes('video')) return a
        if (r0 && r0.codecs && r0.codecs.includes('avc1')) return a
    }
    return null
}

function findAudioAdaptationSet(adaptationSets) {
    const direct = adaptationSets.find(a => (a.$.contentType || '').toLowerCase() === 'audio')
    if (direct) return direct

    for (const a of adaptationSets) {
        if (!a.Representation) continue
        const reps = Array.isArray(a.Representation) ? a.Representation : [a.Representation]
        const r0 = reps[0].$
        if (r0 && r0.mimeType && r0.mimeType.includes('audio')) return a
        if (r0 && r0.codecs && r0.codecs.includes('mp4a')) return a
    }
    return null
}

/* --------------------- Highest Resolution Image --------------------- */
async function downloadHighestResImage(displayResources, folderName, fileName) {
    const best = displayResources.reduce((acc, cur) => (cur.config_width > acc.config_width ? cur : acc))
    const url = best.src
    logDebug('[downloadHighestResImage] =>', url)
    const resp = await fetch(url)
    if (!resp.ok) {
        logDebug('[downloadHighestResImage] Download failed =>', resp.status)
        return
    }
    const buf = Buffer.from(await resp.arrayBuffer())
    fs.mkdirSync(folderName, { recursive: true })
    const outPath = path.join(folderName, fileName)
    fs.writeFileSync(outPath, buf)
    console.log('Saved file =>', fileName, buf.length, 'bytes')
}

/* --------------------- Recursive Media Extraction --------------------- */
async function extractMediaRecursive(item, folderName, postName) {
    let downloadCount = 0

    if (item.edge_sidecar_to_children && item.edge_sidecar_to_children.edges) {
        const edges = item.edge_sidecar_to_children.edges
        for (let i = 0; i < edges.length; i++) {
            const child = edges[i].node
            const childName = postName + '_' + (i + 1)
            downloadCount += await extractMediaRecursive(child, folderName, childName)
        }
        return downloadCount
    }

    if (item.is_video) {
        if (item.dash_info && item.dash_info.video_dash_manifest) {
            console.log('[extractMediaRecursive] is_video => using MPD:', postName)
            await downloadBestQualityDash(item.dash_info.video_dash_manifest, folderName, postName)
            downloadCount++
        } else {
            console.log('[extractMediaRecursive] is_video => but no dash_info.')
        }
    }
    if (Array.isArray(item.display_resources) && item.display_resources.length > 0) {
        const fileName = postName + '.jpg'
        await downloadHighestResImage(item.display_resources, folderName, fileName)
        downloadCount++
    }

    return downloadCount
}

/* --------------------- Instagram --------------------- */
async function handleInstagram(url, mediaType, sizeArg, postName) {
    const ffprobePath = 'ffprobe'
    const ffmpegPath = 'ffmpeg'
    const threshold = parseSizeThreshold(sizeArg)
    let folderName = parseOutputFolder(url)
    postName = postName || folderName

    const browser = await puppeteer.launch()
    const page = await browser.newPage()
    const partialMp4s = {}
    const resources = []
    const items = []

    await page.setRequestInterception(true)
    page.on('request', req => req.continue())

    page.on('response', async res => {
        try {
            if (!res.ok()) return
            const ctype = (res.headers()['content-type'] || '').toLowerCase()

            if (ctype.includes('application/json') && res.url().endsWith('instagram.com/graphql/query')) {
                const buf = await res.buffer()
                const item = findJsonItemWithOwner(buf.toString())
                if (!item) return
                items.push(item)

                const user = item.owner
                if (user && user.username) {
                    // Must always print user name
                    console.log('Found username =>', user.username)
                    folderName = user.username
                    fs.mkdirSync(folderName, { recursive: true })
                    fs.writeFileSync(path.join(folderName, postName + '.json'), JSON.stringify(item))
                }
            }
        } catch (e) {
            logDebug(e)
        }
    })

    await page.goto(url, { waitUntil: 'networkidle2' })
    await new Promise(r => setTimeout(r, 1000))
    await browser.close()

    // Save resources (images, audio) that meet threshold
    resources.forEach(r => filterAndSaveMedia(folderName, r, threshold))

    // For each JSON item, extract recursively
    for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const localName = postName + (i > 0 ? `_${i}` : '')
        await extractMediaRecursive(item, folderName, localName)
    }
}

/* --------------------- Others --------------------- */
async function handleThreads(url, ...args) {
    console.log('Threads not supported yet.')
}
async function handleTwitter(url, ...args) {
    console.log('Twitter not supported yet.')
}

/* --------------------- Main --------------------- */
; (async () => {
    let [, , urlArg, mediaArg, sizeArg, extraFlag] = process.argv

    // If the last argument is --verbose, set isVerbose = true
    // (or handle any argument that is '--verbose')
    if (process.argv.includes('--verbose')) {
        isVerbose = true
    }

    if (!urlArg || urlArg.startsWith('--')) {
        console.log('Usage: node get.js <URL> [mediaType] [size] [--verbose]')
        process.exit(1)
    }

    let domain
    try {
        domain = new URL(urlArg).hostname
    } catch (e) { }

    if (domain && domain.includes('instagram')) {
        await handleInstagram(urlArg, mediaArg || 'any', sizeArg || '0')
    } else if (domain && domain.includes('threads')) {
        await handleThreads(urlArg, mediaArg, sizeArg)
    } else if (domain && domain.includes('twitter')) {
        await handleTwitter(urlArg, mediaArg, sizeArg)
    } else {
        console.log('Unsupported URL:', urlArg)
    }
})()
