#!/usr/bin/env python3
# usage: python3 -I deploy/make-cpa-config.py OUT [PORT AUTHDIR]
# Builds the CLIProxyAPI config for the provider switch from the live config + ~/pag/cpa/secrets.
# Never prints keys. Model lists are explicit: a model missing for the selected provider is an error.
# PORT/AUTHDIR are for a throwaway test instance (use an empty AUTHDIR so Codex OAuth is untouched).
import json, re, sys, os
S = os.path.expanduser("~/pag/cpa/secrets/")
key = lambda f: open(S + f).read().strip()
live = open(os.path.expanduser("~/pag/cpa/config.yaml")).read()
out = sys.argv[1]; port = sys.argv[2] if len(sys.argv) > 2 else "8318"; authdir = sys.argv[3] if len(sys.argv) > 3 else None
mgmt = re.search(r'secret-key:\s*"([^"]*)"', live).group(1)
opencode = key("opencode.key"); client = key("client.key")
claude4 = ["claude-fable-5","claude-fable-5-1","claude-fable-5-2","claude-haiku-4-5-20251001","claude-haiku-5-5","claude-opus-4-6","claude-opus-4-7","claude-opus-4-8","claude-opus-5","claude-opus-5-5","claude-sonnet-4-6","claude-sonnet-5","claude-sonnet-5-5"]
claudeV = {  # PAG/Claude Code name -> Vercel AI Gateway id
 "claude-fable-5":"anthropic/claude-fable-5","claude-fable-5-1":"anthropic/claude-fable-5.1","claude-fable-5-2":"anthropic/claude-fable-5.2",
 "claude-haiku-4-5":"anthropic/claude-haiku-4.5","claude-haiku-4-5-20251001":"anthropic/claude-haiku-4.5","claude-haiku-5-5":"anthropic/claude-haiku-5.5",
 "claude-opus-4-5":"anthropic/claude-opus-4.5","claude-opus-4-6":"anthropic/claude-opus-4.6","claude-opus-4-7":"anthropic/claude-opus-4.7","claude-opus-4-8":"anthropic/claude-opus-4.8",
 "claude-opus-5":"anthropic/claude-opus-5","claude-opus-5-5":"anthropic/claude-opus-5.5",
 "claude-sonnet-4-5":"anthropic/claude-sonnet-4.5","claude-sonnet-4-6":"anthropic/claude-sonnet-4.6","claude-sonnet-5":"anthropic/claude-sonnet-5","claude-sonnet-5-5":"anthropic/claude-sonnet-5.5"}
gem4 = ["gemini-3.1-pro-preview","gemini-3.5-flash","gemini-3.6-flash","gemini-3.7-flash","gemini-3.8-flash","gemini-4-argon","gemini-4-carbon","gemini-4-hydrogen","gemini-4-neon"]
gemV = ["gemini-2.5-flash","gemini-2.5-flash-lite","gemini-2.5-pro","gemini-3-flash","gemini-3.1-flash-lite","gemini-3.1-pro-preview","gemini-3.5-flash","gemini-3.5-flash-lite","gemini-3.6-flash","gemini-3.7-flash","gemini-3.8-flash","gemini-4-argon","gemini-4-carbon","gemini-4-hydrogen","gemini-4-neon"]
q = json.dumps  # JSON strings are valid YAML scalars
iso = "      request-retry: 0      # one attempt, the error goes back to the client\n      disable-cooling: true # no blackout after a failed request\n"
L = []
L.append("# Generated for PAG provider switch. Claude/Gemini upstreams are separated by prefix;\n# pag-front picks c4r|cvc and g4r|gvc from front/settings.json. force-model-prefix keeps\n# unprefixed claude-*/gemini-* away from them, so CLIProxyAPI never falls back across providers.")
L.append(f"management:\n  disable-auto-update-panel: true\n  secret-key: {q(mgmt)}")
L.append(f"server:\n  host: \"127.0.0.1\"\n  port: {port}")
if authdir: L.append(f"oauth:\n  auth-dir: {q(authdir)}")
L.append(f"access:\n  api-keys:\n    - {q(client)}")
L.append("routing:\n  strategy: \"round-robin\"\n  force-model-prefix: true")
c = ["api-keys:", "  claude:",
     "    - name: 4router", "      prefix: c4r", '      base-url: "https://4router.net"', iso.rstrip("\n"), f"      keys:\n        - api-key: {q(key('4router.key'))}", "      models:"]
c += [f"        - {{name: {q(m)}, alias: {q(m)}}}" for m in claude4]
c += ["    - name: vercel-claude", "      prefix: cvc", '      base-url: "https://ai-gateway.vercel.sh"', iso.rstrip("\n"), f"      keys:\n        - api-key: {q(key('vercel.key'))}", "      models:"]
c += [f"        - {{name: {q(v)}, alias: {q(a)}, force-mapping: true}}" for a, v in claudeV.items()]
c += ["  gemini:", "    - name: 4router-gemini", "      prefix: g4r", '      base-url: "https://4router.net"', iso.rstrip("\n"), f"      keys:\n        - api-key: {q(key('4router-gemini.key'))}", "      models:"]
c += [f"        - {{name: {q(m)}, alias: {q(m)}}}" for m in gem4]
c += ["  openai-compatibility:", "    - name: opencode-zen", '      base-url: "https://opencode.ai/zen/v1"', f"      keys:\n        - api-key: {q(opencode)}", "      models:"]
c += [f"        - {{name: {m}, alias: opencode-free}}" for m in ["big-pickle","beam-free","mimo-v2.6-flash-free","deepseek-v4.1-flash-free","glm-5.3-flash-free"]]
c += ["    - name: vercel-gemini", "      prefix: gvc", '      base-url: "https://ai-gateway.vercel.sh/v1"', iso.rstrip("\n"), f"      keys:\n        - api-key: {q(key('vercel.key'))}", "      models:"]
c += [f"        - {{name: {q('google/' + m)}, alias: {q(m)}}}" for m in gemV]
L.append("\n".join(c))
L.append("observability:\n  logs:\n    logging-to-file: true\n    logs-max-total-size-mb: 500\n    request-log: false")
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, ("\n".join(L) + "\n").encode()); os.close(fd)
print("written", out)
