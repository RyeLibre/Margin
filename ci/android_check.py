"""Checks the Android app in an emulator (run by .github/workflows/android.yml).
Starts Margin, connects to its page through Chrome DevTools, opens a small test EPUB,
presses Listen, and saves screenshots plus what the page reported into ci-out/."""
import asyncio, base64, io, json, os, re, subprocess, sys, time, zipfile
import websockets

OUT = 'ci-out'; os.makedirs(OUT, exist_ok=True)
def sh(*a, check=False): return subprocess.run(a, capture_output=True, text=True, check=check).stdout
def shot(name): open(f'{OUT}/{name}.png', 'wb').write(subprocess.run(['adb', 'exec-out', 'screencap', '-p'], capture_output=True).stdout)
log = []
def note(*a): s = ' '.join(str(x) for x in a); print(s); log.append(s)

def test_epub():
    b = io.BytesIO(); z = zipfile.ZipFile(b, 'w')
    z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip')
    z.writestr('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
    z.writestr('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">test-1</dc:identifier><dc:title>A Test Book</dc:title><dc:creator>Margin Check</dc:creator><dc:language>en</dc:language><dc:date>2026</dc:date></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>')
    z.writestr('OEBPS/nav.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">One</a></li><li><a href="c2.xhtml">Two</a></li></ol></nav></body></html>')
    para = 'The river ran north through the valley, and the people who lived beside it planted rice in the wet months and hunted in the dry ones. '
    for i in (1, 2):
        z.writestr(f'OEBPS/c{i}.xhtml', f'<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter {i}</title></head><body><h1>Chapter {i}</h1>' + ''.join(f'<p>{para * 3}</p>' for _ in range(6)) + '</body></html>')
    z.close(); return b.getvalue()

async def main():
    sh('adb', 'install', '-r', sys.argv[1], check=True)
    sh('adb', 'shell', 'pm', 'grant', 'app.margin.reader', 'android.permission.POST_NOTIFICATIONS')
    sh('adb', 'logcat', '-c')
    sh('adb', 'shell', 'am', 'start', '-n', 'app.margin.reader/.MainActivity')
    sock = None
    for _ in range(60):
        time.sleep(2)
        m = re.search(r'@(webview_devtools_remote_\d+)', sh('adb', 'shell', 'cat', '/proc/net/unix'))
        if m: sock = m.group(1); break
    note('devtools socket:', sock)
    sh('adb', 'forward', 'tcp:9222', 'localabstract:' + sock)
    time.sleep(8)
    pages = json.loads(subprocess.run(['curl', '-s', 'http://127.0.0.1:9222/json'], capture_output=True, text=True).stdout)
    page = next(p for p in pages if 'margin.example' in p.get('url', ''))
    note('page:', page['url'])
    async with websockets.connect(page['webSocketDebuggerUrl'], max_size=2**26) as ws:
        seq = 0
        async def ev(expr, await_promise=True):
            nonlocal seq; seq += 1; my = seq
            await ws.send(json.dumps({'id': my, 'method': 'Runtime.evaluate', 'params': {'expression': expr, 'awaitPromise': await_promise, 'returnByValue': True}}))
            while True:
                r = json.loads(await ws.recv())
                if r.get('id') == my:
                    res = r.get('result', {})
                    if 'exceptionDetails' in res: return 'EXCEPTION: ' + json.dumps(res['exceptionDetails'])[:400]
                    return res.get('result', {}).get('value')
        await ws.send(json.dumps({'id': 0, 'method': 'Runtime.enable'}))
        await asyncio.sleep(3)
        note('android shim:', await ev("document.documentElement.classList.contains('android')"))
        note('bridge:', await ev("!!(window.chrome && chrome.webview && chrome.webview.hostObjects)"))
        note('cross-origin isolated:', await ev('self.crossOriginIsolated'))
        note('theme:', await ev("document.documentElement.dataset.theme"))
        note('engine/voices:', await ev("[document.getElementById('engine')?.value, speechSynthesis.getVoices().length, [...document.querySelectorAll('#voice option')].slice(0,4).map(o=>o.textContent)]"))
        shot('1-start')
        b64 = base64.b64encode(test_epub()).decode()
        note('open book:', await ev(f"(async()=>{{ const b=Uint8Array.from(atob('{b64}'),c=>c.charCodeAt(0)); await marginHost.openFile(new File([b],'A Test Book.epub',{{type:'application/epub+zip'}})); return document.getElementById('title').textContent; }})()"))
        await asyncio.sleep(4); shot('2-book')
        note('play:', await ev("(()=>{document.getElementById('bPlay').click(); return 'clicked'})()"))
        await asyncio.sleep(8)
        note('after play:', await ev("[document.getElementById('statusText')?.textContent, document.getElementById('bPlay')?.textContent.trim()]"))
        shot('3-listening')
        sh('adb', 'shell', 'input', 'keyevent', 'KEYCODE_HOME'); await asyncio.sleep(6)
        note('in background, still playing:', await ev("document.getElementById('bPlay')?.textContent.trim()"))
        sh('adb', 'shell', 'cmd', 'statusbar', 'expand-notifications'); await asyncio.sleep(3); shot('4-notification')
        sh('adb', 'shell', 'cmd', 'statusbar', 'collapse')
        sh('adb', 'shell', 'am', 'start', '-n', 'app.margin.reader/.MainActivity'); await asyncio.sleep(3)
        note('back button:', await ev("marginHost.back()"))
        await asyncio.sleep(2); shot('5-library')
        note('notes page:', await ev("(()=>{document.getElementById('bNotes').click(); return 'ok'})()"))
        await asyncio.sleep(2); shot('6-notes')
    lc = sh('adb', 'logcat', '-d')
    keep = [l for l in lc.splitlines() if re.search(r'chromium|Console|AndroidRuntime|FATAL|margin|TextToSpeech|PlaybackService', l, re.I)]
    open(f'{OUT}/logcat.txt', 'w').write('\n'.join(keep[-400:]))
    open(f'{OUT}/report.txt', 'w').write('\n'.join(log))

asyncio.run(main())
