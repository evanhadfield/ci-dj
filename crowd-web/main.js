// crowd-web entry (Phase 0). Reads /c/{code} and paints it. Phase 1
// adds the onboarding overlay + Now / Vibes / Room screens
// (docs/collective/PLAN.md §7b).
const match = window.location.pathname.match(/^\/c\/([^/]+)/)
const code = match ? decodeURIComponent(match[1] || '').toUpperCase() : ''
const codeNode = document.getElementById('code')
if (codeNode) codeNode.textContent = code || '?'
