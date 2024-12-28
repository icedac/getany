# getany

A Node.js script that automatically downloads original raw videos and images from sns.

## Requirements
- Node.js 14+
- npm or yarn
- ffmpeg and ffprobe (see installation guides below)

## Installing ffmpeg / ffprobe

### Windows
1. Download a Windows build from [the official ffmpeg site](https://ffmpeg.org/download.html).
2. Extract the archive and place `ffmpeg.exe` and `ffprobe.exe` in your `PATH`.

### macOS
```
brew install ffmpeg
```
Or download [official builds](https://evermeet.cx/ffmpeg/) and place them in `/usr/local/bin`.

### Linux (Ubuntu example)
```
sudo apt-get update
sudo apt-get install ffmpeg
```

## Setup and Usage
1. Install dependencies:
```
npm install
```
2. Run the script:
```
node get.js <URL> [mediaType] [size]
```
- **URL**: Media page URL on Instagram or other supported sites  
- **mediaType** (optional): `image`, `video`, or `any` (default: `any`)  
- **size** (optional): Minimum resource size (e.g., `10240` or `10k`)  

Example:
```
node script.js https://www.instagram.com/p/xxxx/
```

All downloaded files (mp4, jpg, etc.) will appear in a new folder named after the username