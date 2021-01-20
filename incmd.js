module.exports = [
  // IN
  '-re',
  '-i', '-',
  // OUT
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-tune', 'zerolatency',
  '-c:a', 'aac',
  '-ar', '44100',
  '-f' ,'flv',
  'rtmp://localhost/live/test'
]