# Lobe Icons

SkillHub vendors a selected set of static SVG assets from LobeHub's Lobe Icons
repository. The files are copied into the application bundle and are not loaded
from a remote URL at runtime.

- Upstream: https://github.com/lobehub/lobe-icons
- Package: `@lobehub/icons-static-svg`
- Source commit: `a94750e3f5f8fc33757b839d85030e742284e43a`
- License: MIT; see [LICENSE](./LICENSE)

The bundled files are under
`apps/desktop/public/brand/agents/lobehub/`. Files with a `-color` source were
stored under the normalized SkillHub filename:

| SkillHub file | Lobe Icons source |
| --- | --- |
| `anthropic.svg` | `anthropic.svg` |
| `cline.svg` | `cline.svg` |
| `codebuddy.svg` | `codebuddy-color.svg` |
| `codex.svg` | `codex-color.svg` |
| `cursor.svg` | `cursor.svg` |
| `github-copilot.svg` | `githubcopilot.svg` |
| `gemini.svg` | `gemini-color.svg` |
| `grok.svg` | `grok.svg` |
| `hermes-agent.svg` | `hermesagent.svg` |
| `kimi.svg` | `kimi-color.svg` |
| `openai.svg` | `openai.svg` |
| `openclaw.svg` | `openclaw-color.svg` |
| `opencode.svg` | `opencode.svg` |
| `qoder.svg` | `qoder-color.svg` |
| `trae.svg` | `trae-color.svg` |
| `windsurf.svg` | `windsurf.svg` |
| `zai.svg` | `zai.svg` |

`zai.svg` is used for the ZCode profile because the product brand is Z.ai and
ZCode is the client name. CoMate is intentionally not included.
