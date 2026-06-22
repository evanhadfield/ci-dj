// host-screen entry (Phase 0). POSTs /api/rooms once on load, then
// paints the returned QR + 4-char code. Phase 1 adds the vibe opinion
// map + the approval-temperature trace (docs/collective/PLAN.md §7c).

async function createRoom() {
  const response = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!response.ok) throw new Error(`aggregator: ${response.status}`)
  return response.json()
}

function render({ code, joinUrl, qrSvg }) {
  const qrNode = document.getElementById('qr')
  if (qrNode) qrNode.innerHTML = qrSvg
  const codeNode = document.getElementById('code')
  if (codeNode) codeNode.textContent = code.split('').join(' ')
  const urlNode = document.getElementById('url')
  if (urlNode) urlNode.textContent = joinUrl
}

createRoom()
  .then(render)
  .catch((error) => {
    const codeNode = document.getElementById('code')
    if (codeNode) codeNode.textContent = '— —'
    const urlNode = document.getElementById('url')
    if (urlNode) urlNode.textContent = `Aggregator unreachable: ${error.message}`
  })
