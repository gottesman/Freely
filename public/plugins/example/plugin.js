// OPTIONAL: plugin JS shim (not used by prototype) — shows how a plugin could expose an http-based search
export async function search(query){
  // In production this might call remote API, or return local index results
  return [
    { id: 'demo:1', title: 'Demo Track', artists:['Demo Artist'], duration: 120 }
  ]
}