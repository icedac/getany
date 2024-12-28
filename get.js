const puppeteer = require('puppeteer')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const sizeOf = require('image-size')
const xml2js = require('xml2js')
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args))

function parseThreshold(t){
 if(!t) return 10240
 let m=t.match(/^(\d+)(k?)$/i)
 if(!m) return 10240
 let n=parseInt(m[1])
 return m[2].toLowerCase()==='k' ? n*1024 : n
}

function getFolderName(u){
 try{
   let p=new URL(u).pathname.replace(/\/+$/,'')
   let f=p.substring(p.lastIndexOf('/')+1)||'output'
   return f.replace(/[^\w-]/g,'') || 'output'
 }catch(e){
   return 'output'
 }
}

function getDurationSec(ffprobePath,filePath){
 try{
   return parseFloat(execSync(
     `${ffprobePath} -v error -select_streams v:0 -show_entries format=duration -of csv=p=0 "${filePath}"`
   ).toString().trim())
 }catch{
   return 0
 }
}

function filterAndSaveResource(folderName,r,threshold){
 if(r.buf.length < threshold) return false
 let base = path.basename(new URL(r.url).pathname) || 'file'
 if(!/\.[a-zA-Z0-9]+$/.test(base)){
   let e = r.ctype.split(';')[0].split('/')[1]
   if(e) base+='.'+e
 }
 if(Buffer.byteLength(base,'utf8')>128) return false

 if(r.ctype.startsWith('image/')){
   if(r.ctype==='image/png') return false
   try{
     let dim=sizeOf(r.buf)
     if(dim.width<161 || dim.height<161) return false
   }catch(e){
     return false
   }
 }
 fs.mkdirSync(folderName,{recursive:true})
 //fs.writeFileSync(path.join(folderName,base),r.buf)
 //console.log('Saved resource =>', base, r.buf.length, 'bytes')
 return true
}

// ------------------- partial mp4 합치는 로직 -------------------
function combineMp4Chunks(partialMp4s, folderName, threshold, mediaArg){
 const FILENAME_LIMIT=256
 let results = []

 for(let [base,chunks] of Object.entries(partialMp4s)){
   chunks.sort((a,b)=>a.start - b.start)
   let combined = Buffer.concat(chunks.map(x=>x.chunk))
   if(combined.length<threshold) continue
   if(!['video','any','mp4combine'].includes(mediaArg)) continue

   let ext = path.extname(base)||'.mp4'
   let name= path.basename(base,ext)
   let fileName = name + ext
   if(Buffer.byteLength(fileName,'utf8')>FILENAME_LIMIT) continue

   let outPath=path.join(folderName,fileName)
   fs.writeFileSync(outPath, combined)
   console.log('Saved mp4 chunk =>', fileName, combined.length, 'bytes')
   results.push(outPath)
 }
 return results
}

function mergeVideoAudio(folderName, postName, ffmpegPath, ffprobePath){
 const mp4List = fs.readdirSync(folderName)
   .filter(f=>f.toLowerCase().endsWith('.mp4'))
   .map(f=>{
     let full=path.join(folderName,f)
     let stat=fs.statSync(full)
     return {name:f,size:stat.size,fullPath:full}
   })
   .sort((a,b)=>b.size - a.size)

 if(mp4List.length<2) return

 let videoFile=mp4List[0]
 let audioFile=mp4List[1]
 let videoDur=getDurationSec(ffprobePath, videoFile.fullPath)
 let audioDur=getDurationSec(ffprobePath, audioFile.fullPath)
 if(Math.abs(videoDur - audioDur) < 0.5){
   let finalOut = path.join(folderName, postName+'.mp4')
   try{
     execSync(`${ffmpegPath} -y -i "${videoFile.fullPath}" -i "${audioFile.fullPath}" -c copy -map 0:v:0 -map 1:a:0 "${finalOut}"`)
     let mergedStat = fs.statSync(finalOut)
     console.log('Merged final mp4 =>', path.basename(finalOut), mergedStat.size, 'bytes')
   }catch(e){
     console.log('ffmpeg merge failed', e)
   }
 }
}

// ------------------- JSON 파싱 -------------------
function findItemWithOwner(jsonStr){
 try{
   let obj = JSON.parse(jsonStr)
   return deepFindItemWithOwner(obj)
 }catch{
   return null
 }
}

function deepFindItemWithOwner(obj){
 if(!obj || typeof obj!=='object') return null
 if(obj.owner && obj.owner.username) return obj
 for(let k in obj){
   let sub = deepFindItemWithOwner(obj[k])
   if(sub) return sub
 }
 return null
}

// ------------------- DASH mp4 다운로드 -------------------
async function downloadRange(url, start, end) {
 let headers = {}
 let rangeDesc = 'FULL'
 if(start!==undefined && end!==undefined){
   headers.Range = `bytes=${start}-${end}`
   rangeDesc = `${start}-${end}`
 }
 console.log(`[downloadRange] Requesting [${rangeDesc}] => ${url.substring(0,100)}...`)
 let res = await fetch(url, {headers})
 console.log(`[downloadRange] Response code: ${res.status}`)
 if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)

 let buf = Buffer.from(await res.arrayBuffer())
 console.log(`[downloadRange] Received chunk => ${buf.length} bytes for [${rangeDesc}]`)
 return buf
}

function parseRange(str){
 let m = str.match(/^(\d+)-(\d+)$/)
 if(!m) return null
 return [ parseInt(m[1],10), parseInt(m[2],10) ]
}

async function downloadDashRepresentation(repr) {
 let baseURL = repr.BaseURL[0]
 let segBase = repr.SegmentBase[0]
 let id = repr.$.id

 console.log(`\n[downloadDashRepresentation] Representation ID="${id}"`)

 let totalLen = parseInt(repr.$.FBContentLength || '0', 10)

 let initRangeStr = segBase.Initialization[0].$.range
 let initRange = parseRange(initRangeStr) || [0,0]
 console.log(`[downloadDashRepresentation] initRange=${initRangeStr}`)

 let initBuf = await downloadRange(baseURL, initRange[0], initRange[1])
 let chunks = [initBuf]

 if(totalLen>0){
   let startByte = initRange[1]+1
   let endByte   = totalLen-1
   console.log(`[downloadDashRepresentation] Download entire => ${startByte}-${endByte}`)
   let mainBuf = await downloadRange(baseURL, startByte, endByte)
   chunks.push(mainBuf)
 } else {
   let srA = segBase.$.FBFirstSegmentRange
   let srB = segBase.$.FBSecondSegmentRange
   let srP = segBase.$.FBPrefetchSegmentRange
   let segRanges = []
   if(srA) segRanges.push(srA)
   if(srB) segRanges.push(srB)
   if(srP && !segRanges.includes(srP)) segRanges.push(srP)
   for(let sr of segRanges){
     let [s,e] = parseRange(sr)
     console.log(`[downloadDashRepresentation] Download => ${sr}`)
     let segBuf = await downloadRange(baseURL, s, e)
     chunks.push(segBuf)
   }
 }

 let resultBuf = Buffer.concat(chunks)
 console.log(`[downloadDashRepresentation] Combined => ${resultBuf.length} bytes for ID="${id}"`)
 return resultBuf
}

async function mergeVideoAudioDash(videoBuf, audioBuf, outPath='final.mp4'){
 fs.writeFileSync('temp_video.mp4', videoBuf)
 fs.writeFileSync('temp_audio.mp4', audioBuf)
 try {
   execSync(`ffmpeg -y -i temp_video.mp4 -i temp_audio.mp4 -c copy -map 0:v:0 -map 1:a:0 "${outPath}" > /dev/null 2>&1`)
   let mergedStat = fs.statSync(outPath)
   console.log(`[mergeVideoAudioDash] Done => ${outPath}, size=${mergedStat.size} bytes`)
 } catch(e){
   console.log('[mergeVideoAudioDash] ffmpeg merge error:', e)
 } finally {
   try{ fs.unlinkSync('temp_video.mp4') }catch(e){}
   try{ fs.unlinkSync('temp_audio.mp4') }catch(e){}
 }
}

async function downloadHighestQualityDash(mpdXml, folderName, postName){
  console.log('[downloadHighestQualityDash] Start parsing MPD XML')
  let parsed = await xml2js.parseStringPromise(mpdXml)
  let period = parsed.MPD.Period[0]

  // AdaptationSet이 여러 개 있을 수 있음
  let adaptationSets = period.AdaptationSet
  if(!Array.isArray(adaptationSets)) {
    console.log('[downloadHighestQualityDash] No adaptation sets array?')
    return
  }

  // 1) 비디오 후보 찾기
  let videoSet = findVideoAdaptationSet(adaptationSets)
  // 2) 오디오 후보 찾기
  let audioSet = findAudioAdaptationSet(adaptationSets)

  if(!videoSet){
    console.log('[downloadHighestQualityDash] Could not find a video adaptation set.')
    return
  }
  if(!audioSet){
    console.log('[downloadHighestQualityDash] Could not find an audio adaptation set.')
    return
  }

  // 3) 각 adaptationSet에서 Representation 배열을 얻음
  let videoReprs = Array.isArray(videoSet.Representation)
    ? videoSet.Representation
    : [videoSet.Representation]
  let audioReprs = Array.isArray(audioSet.Representation)
    ? audioSet.Representation
    : [audioSet.Representation]

  // 4) 최고 화질(대역폭) 골라내기
  videoReprs.sort((a,b)=>{
    let bA = parseInt(a.$.bandwidth||'0',10)
    let bB = parseInt(b.$.bandwidth||'0',10)
    return bB - bA
  })
  let bestVideo = videoReprs[0]

  audioReprs.sort((a,b)=>{
    let bA = parseInt(a.$.bandwidth||'0',10)
    let bB = parseInt(b.$.bandwidth||'0',10)
    return bB - bA
  })
  let bestAudio = audioReprs[0]

  console.log('[downloadHighestQualityDash] Chosen video =>', bestVideo.$.id, bestVideo.$.bandwidth)
  console.log('[downloadHighestQualityDash] Chosen audio =>', bestAudio.$.id, bestAudio.$.bandwidth)

  // 5) 각각 다운로드
  let videoBuf = await downloadDashRepresentation(bestVideo)
  let audioBuf = await downloadDashRepresentation(bestAudio)

  // 6) 병합
  let finalPath = path.join(folderName, postName+'.mp4')
  await mergeVideoAudioDash(videoBuf, audioBuf, finalPath)
  console.log(`[downloadHighestQualityDash] Final => ${finalPath}`)
}

/** 
 * video인지 판단:
 *  1) contentType="video"
 *  2) 혹은 Representation[0].$.mimeType.includes('video') or codecs contains 'avc1'
 */
function findVideoAdaptationSet(adaptationSets){
  // 1) contentType="video" 우선 탐색
  let vid = adaptationSets.find(a => (a.$.contentType||'').toLowerCase()==='video')
  if(vid) return vid

  // 2) fallback: Representation mimeType="video/mp4" or codecs="avc1"
  for(let a of adaptationSets){
    if(!a.Representation) continue
    let reps = Array.isArray(a.Representation) ? a.Representation : [a.Representation]
    // 첫번째 Representation 검사
    let r0 = reps[0].$
    if(r0 && r0.mimeType && r0.mimeType.includes('video')) {
      return a
    }
    if(r0 && r0.codecs && r0.codecs.includes('avc1')) {
      return a
    }
  }
  return null
}

/** 
 * audio인지 판단:
 *  1) contentType="audio"
 *  2) 혹은 Representation[0].$.mimeType.includes('audio') or codecs=mp4a
 */
function findAudioAdaptationSet(adaptationSets){
  // 1) contentType="audio" 우선 탐색
  let aud = adaptationSets.find(a => (a.$.contentType||'').toLowerCase()==='audio')
  if(aud) return aud

  // 2) fallback: Representation mimeType="audio/mp4" or codecs="mp4a"
  for(let a of adaptationSets){
    if(!a.Representation) continue
    let reps = Array.isArray(a.Representation) ? a.Representation : [a.Representation]
    let r0 = reps[0].$
    if(r0 && r0.mimeType && r0.mimeType.includes('audio')) {
      return a
    }
    if(r0 && r0.codecs && r0.codecs.includes('mp4a')) {
      return a
    }
  }
  return null
}


// ------------------- display_resources 중 최고 해상도 이미지 -------------------
async function downloadHighestResImage(displayResources, folderName, fileName){
 let best = displayResources.reduce((acc, cur) => {
   return (cur.config_width > acc.config_width) ? cur : acc
 })
 let url = best.src
 console.log('[downloadHighestResImage] =>', url)
 let resp = await fetch(url)
 if(!resp.ok){
   console.log('[downloadHighestResImage] Download failed =>', resp.status)
   return
 }
 let buf = Buffer.from(await resp.arrayBuffer())
 fs.mkdirSync(folderName, {recursive:true})
 let outPath = path.join(folderName, fileName)
 fs.writeFileSync(outPath, buf)
 console.log('[downloadHighestResImage] Saved =>', outPath, buf.length, 'bytes')
}

// ------------------- (새로 추가) 여러 이미지/비디오를 재귀적으로 받기 위한 함수 -------------------
async function extractMedia(item, folderName, postName){
  let downdloadCount = 0
 // 1) sidecar(=여러 장) 있는 경우 → 재귀
 if(item.edge_sidecar_to_children && item.edge_sidecar_to_children.edges){
   let edges = item.edge_sidecar_to_children.edges
   for(let i=0; i<edges.length; i++){
     let child = edges[i].node
     let childName = postName + '_' + (i+1)  // 예) postName_child1
     downdloadCount += await extractMedia(child, folderName, childName)
   }
   return
 }

 // 2) 이미지인지 비디오인지 구분
 if(item.is_video){
   // mp4 (dash_info가 있으면 downloadHighestQualityDash)
   if(item.dash_info && item.dash_info.video_dash_manifest){
     console.log('[extractMedia] is_video => using MPD:', postName)
     await downloadHighestQualityDash(item.dash_info.video_dash_manifest, folderName, postName)
     downdloadCount += 1;
   } else {
     console.log('[extractMedia] is_video => but no dash_info. Possibly partial mp4 or fallback.')
     // 여기선 partial mp4 fallback이 필요하면 따로 구현
   }
 } else {
 }

  // 3) 이미지는 비디오일 경우도 대표 이미지를 받아옴
  if(Array.isArray(item.display_resources) && item.display_resources.length>0){
    let fileName = postName + '.jpg'
    await downloadHighestResImage(item.display_resources, folderName, fileName)
    downdloadCount += 1;
  }
 
 return downdloadCount
}

// ------------------- 메인 로직: Instagram -------------------
async function extractFromInstagram(url, mediaArg, sizeArg, postName){
 const ffprobePath='ffprobe'
 const ffmpegPath='ffmpeg'
 let threshold = parseThreshold(sizeArg)
 let folderName = getFolderName(url)
 postName = postName || folderName

 let browser = await puppeteer.launch()
 let page = await browser.newPage()
 let partialMp4s = {}
 let resources   = []
 let items = []

 await page.setRequestInterception(true)
 page.on('request', req => req.continue())

 page.on('response', async res => {
   try{
     if(!res.ok()) return
     let ctype=(res.headers()['content-type']||'').toLowerCase()

     // JSON -> item
     if(ctype.includes('application/json') && res.url().endsWith('instagram.com/graphql/query')){
       let buf = await res.buffer()
       let item = findItemWithOwner(buf.toString())
       if(!item) return
       items.push(item)

       let user = item.owner
       if(user && user.username){
         console.log('Found username =>', user.username)
         folderName = user.username
         fs.mkdirSync(folderName, {recursive:true})
         fs.writeFileSync(path.join(folderName, postName+'.json'), JSON.stringify(item))
       }
     }
     // partial mp4
     else if(ctype.startsWith('video/mp4')){
       let urlObj = new URL(res.url())
       let base   = path.basename(urlObj.pathname)||'video.mp4'
       if(!base.toLowerCase().endsWith('.mp4')) base += '.mp4'

       let chunk = await res.buffer()
       let bytestart = urlObj.searchParams.get('bytestart')
       let byteend   = urlObj.searchParams.get('byteend')
       partialMp4s[base] = partialMp4s[base]||[]
       if(bytestart && byteend){
         let start = parseInt(bytestart,10)
         let end   = parseInt(byteend,10)
         partialMp4s[base].push({start,end,chunk})
       } else {
         partialMp4s[base].push({start:0,end:chunk.length-1,chunk})
       }
     }
     // 그 외 (이미지/audio 등)
     else{
       if(mediaArg==='image' && ctype.startsWith('image/')){
         resources.push({url:res.url(), ctype, buf:await res.buffer()})
       }
       else if(mediaArg==='video' && ctype.includes('audio/mpeg')){
         resources.push({url:res.url(), ctype, buf:await res.buffer()})
       }
       else if(mediaArg==='any'){
         let ctyles=['image/','video/','audio/']
         if(ctyles.some(c=>ctype.startsWith(c))){
           resources.push({url:res.url(), ctype, buf:await res.buffer()})
         }
       }
     }
   }catch(e){}
 })

 await page.goto(url, {waitUntil:'networkidle2'})
 await new Promise(r=>setTimeout(r,1000)) // 추가로 1초 대기
 await browser.close()

 // 기타 리소스(이미지/오디오) 저장
 resources.forEach(r => {
   filterAndSaveResource(folderName, r, threshold)
 })

 // JSON item에 대해 extractMedia() 호출
 for(let i=0; i<items.length; i++){
   let item = items[i]
   let localName = postName + (i>0 ? `_${i}` : '') // 여러 item 있을 때 구분
   await extractMedia(item, folderName, localName)
 }

 // console.log('[extractFromInstagram] Check partial mp4 fallback.')
 // combineMp4Chunks(partialMp4s, folderName, threshold, mediaArg)
 // mergeVideoAudio(folderName, postName, ffmpegPath, ffprobePath)
}

// ------------------- 기타 (Threads, Twitter) -------------------
async function extractFromThreads(url,...args){
 console.log("Threads는 아직 지원 안합니다.")
}
async function extractFromTwitter(url,...args){
 console.log("Twitter는 아직 지원 안합니다.")
}

// ------------------- 메인 -------------------
;(async()=>{
 let [,,urlArg,mediaArg,sizeArg] = process.argv
 if(!urlArg){
   console.log('Usage: node script.js <URL> [mediaType] [size]')
   process.exit(1)
 }
 let domain
 try { domain = new URL(urlArg).hostname } catch(e){}

 if(domain && domain.includes('instagram')){
   await extractFromInstagram(urlArg, mediaArg||'any', sizeArg||'0')
 }
 else if(domain && domain.includes('threads')){
   await extractFromThreads(urlArg,mediaArg,sizeArg)
 }
 else if(domain && domain.includes('twitter')){
   await extractFromTwitter(urlArg,mediaArg,sizeArg)
 }
 else {
   console.log('지원하지 않는 URL:', urlArg)
 }
})()
