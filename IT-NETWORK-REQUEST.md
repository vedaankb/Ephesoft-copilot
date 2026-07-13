
## What's going on

I installed a small proof-of-concept app on the Windows machine. It's all set up
and running — I installed every dependency, the app launches fine, and the
interface works. The **only** thing failing is that the app can't talk to
Google's Gemini API over the internet. Every time it tries, the connection gets
blocked by the corporate network.

It's not the app and it's not the API key — I tested both. The network is stopping
the request. This is **outbound only** (the app just needs to call out to
Google's API, like a browser hitting a website). Nothing is being opened up
*into* the company.

## What I actually see when it fails

When the app tries to reach Google, I get certificate / SSL errors like:

- `CERTIFICATE_VERIFY_FAILED`
- `certificate verify failed: unable to get local issuer certificate`

And when I tested a direct connection, it got cut off with
*"an established connection was aborted by the software in your host machine."*

Translation: our network's security/proxy is inspecting the encrypted traffic and
re-signing it with our internal certificate, and it's also blocking the app's
direct connection. The app doesn't recognize our internal certificate, so it
refuses to continue. (My browser works fine because Windows already trusts the
internal certificate — the app doesn't get that automatically.)

## What I need you to do (whichever is easiest for you)

The app needs to reach these Google addresses over HTTPS (port 443):

- `generativelanguage.googleapis.com`  ← the main one
- `oauth2.googleapis.com`
- `www.googleapis.com`

**Option 1 (easiest for me, probably easiest for you too):**
Allow these addresses through **without** SSL/TLS inspection — i.e. add them to
the bypass/allowlist so the app sees Google's real certificate. If you do this,
I don't have to change anything on my end.

**Option 2 (if inspection has to stay on):**
Send me our **internal root certificate** file (the one the inspection proxy uses
to re-sign traffic) — a `.cer`, `.crt`, or `.pem`. I'll point the app at it so it
trusts our certificate. I'm keeping full security checks on — just adding our cert
to the list the app trusts.

**Option 3 (only if the app must go through the proxy to get out):**
Since my direct connection got blocked, the app might need to use the corporate
proxy explicitly. If so, send me:

- the proxy address and port (like `proxy.company.com:8080`)
- whether it needs a login/authentication
- confirmation those Google addresses are allowed through the proxy

Usually **Option 1** alone fixes it. If not, it's **Option 2 + Option 3** together.

## What to send back to me

Just reply with whichever applies:

- "Done — those Google addresses are allowlisted/bypassed from inspection," **or**
- the **internal root certificate file**, **and/or**
- the **proxy address + port (and login info if needed)**

Once I get that, I can finish setup and run the demo. It's a temporary POC, so if
you'd rather scope this to just my machine/user and remove it afterward, that's
totally fine. Thanks a ton!