"""
ZAP's baseline scan of the console, as Martin's signed-in browser (`scan.ts` starts it): every request ZAP sends
carries his session's cookie and its token, as his browser's do, and it reads the pages and routes its spider cannot
find in the page's HTML, which the page's script draws or calls. It writes nothing that would change the factory: the
two writes it sends are the first halves of signing in and enrolling, which make a challenge and nothing else.
"""
import json
import os
import sys
import threading
import time

# Set once ZAP answers zap-baseline.py, after which its stopping is the scan's end, not a failure.
answered = threading.Event()


def start_zap(port, extra_zap_params):
    # Called as zap-baseline.py starts ZAP. If ZAP stops before it answers, as when it cannot listen on its port,
    # zap-baseline.py would wait ten minutes for it; this stops the scan as soon as ZAP does, with ZAP's log.
    threading.Thread(target=stop_with_zap, daemon=True).start()


def stop_with_zap():
    # ZAP's script, which zap-baseline.py starts as its child.
    while (zap := next(children('/zap/zap-x.sh'), None)) is None:
        time.sleep(0.1)
    try:
        os.waitpid(zap, 0)
    except ChildProcessError:
        pass  # Python's subprocess module reaped it first: it has stopped all the same.
    if answered.is_set():
        return
    try:
        with open('zap.out') as log:
            sys.stderr.write(log.read())
    except OSError:
        pass
    sys.stderr.write('ZAP stopped before it answered: its log, if it wrote one, is above.\n')
    sys.stderr.flush()
    os._exit(3)


def children(program):
    # This process's children running `program`.
    me = str(os.getpid())
    for pid in filter(str.isdigit, os.listdir('/proc')):
        try:
            with open(f'/proc/{pid}/stat') as stat, open(f'/proc/{pid}/cmdline', 'rb') as cmdline:
                # pid (name) state ppid …, and the name may hold spaces or brackets.
                if (stat.read().rsplit(')', 1)[1].split()[1] == me
                        and program.encode() in cmdline.read().split(b'\0')):
                    yield int(pid)
        except (OSError, IndexError):
            pass


def zap_started(zap, target):
    answered.set()
    # Every request ZAP sends, Martin's session with it: through the proxy, the console's server never sees the cookie.
    for header, value in (('Cookie', os.environ['SF_SESSION_COOKIE']), ('X-CSRF-Token', os.environ['SF_CSRF_TOKEN'])):
        zap.replacer.add_rule(description=header, enabled='true', matchtype='REQ_HEADER', matchregex='false',
                              matchstring=header, replacement=value)


def zap_tuned(zap):
    target = os.environ['SF_TARGET'].rstrip('/')
    origin = os.environ['SF_ORIGIN']
    # What the page draws or asks for once its script runs: the doors, the events, and the admin service's reads. The
    # live streams are left out: they never end, so ZAP would wait on them until it timed out.
    for path in ('/?view=sign-in', '/?view=enrol', '/api/events?after=0', '/health', '/version',
                 '/admin/health', '/admin/session', '/admin/no-such-route'):
        zap.core.access_url(url=target + path, followredirects='false')
    # A write's answer is scanned too: the options for signing in, and an enrolment code refused.
    host = target.split('://', 1)[1]
    for path, body in (('/admin/sign-in/options', '{}'), ('/admin/enrol/options', '{"code":"not a code"}')):
        request = (f'POST {target}{path} HTTP/1.1\r\nHost: {host}\r\nOrigin: {origin}\r\n'
                   f'Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n{body}')
        zap.core.send_request(request=request, followredirects='false')


def zap_pre_shutdown(zap):
    # What ZAP reached, and how each answered, for scan.ts to check that the scan saw the console and the admin service,
    # signed in: a scan that reached nothing would find nothing, and pass.
    target = os.environ['SF_TARGET'].rstrip('/')
    reached = {}
    for message in zap.core.messages(baseurl=target):
        method, url = message['requestHeader'].split(' ')[0:2]
        status = message['responseHeader'].split(' ')[1] if message['responseHeader'] else '0'
        reached[f'{method} {url[len(target):] or "/"}'] = int(status)
    with open('/zap/wrk/reached.json', 'w') as out:
        json.dump(reached, out, indent=2, sort_keys=True)
