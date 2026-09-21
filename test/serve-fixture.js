// Local disposable page for loaded-extension observations. Ctrl-C stops it.
import { createServer } from 'node:http'
const html = `<!doctype html><meta charset="utf-8"><title>Shotgun PNG fixture</title>
<style>body{margin:0;font:24px system-ui;background:#f9f7ed}header{padding:24px;background:#193c55;color:white}
main{height:2400px;background:repeating-linear-gradient(37deg,#e59759 0px,#e59759 17px,#77b6a4 17px,#77b6a4 34px);position:relative}
footer{padding:24px;background:#603c58;color:white}.mark{position:absolute;left:32px;top:1100px;background:white;padding:24px}</style>
<header>Shotgun exact PNG fixture — viewport begins here</header><main><div class="mark">Middle: 1100 CSS pixels into content</div></main>
<footer>Full-page capture ends here</footer>`
const server = createServer((request, response) => {
  if (request.url !== '/') { response.writeHead(404); response.end(); return }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(html)
})
server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/` }) + '\n'))
