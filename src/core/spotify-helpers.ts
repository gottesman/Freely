import SpotifyClient, { SpotifyTrack } from './spotify';

type SimpleTrack = { id: string; name: string; artists?: { name: string }[]; album?: { name?: string; images?: { url: string }[] } }

async function getClient(): Promise<SpotifyClient> {
  // Prefer a pre-warmed client if available on window
  const w: any = window;
  if (w.__freelySpotifyClient) return w.__freelySpotifyClient as SpotifyClient;
  try {
    // Create a short-lived client
    return new SpotifyClient();
  } catch (e) {
    return new SpotifyClient();
  }
}

function mapToSimple(t: any): SimpleTrack {
  if (!t) return null as any;
  return {
    id: String(t.id),
    name: t.name,
    artists: (t.artists || []).map((a: any) => ({ name: a.name })),
    album: t.album ? { name: t.album.name, images: t.album.images || [] } : undefined
  } as SimpleTrack;
}

export async function fetchAlbumTracks(albumId: string | number, opts: { limit?: number } = {}): Promise<SimpleTrack[] | undefined> {
  const w: any = window;
  try {
    if (w.electron?.spotify?.getAlbumTracks) {
      const res = await w.electron.spotify.getAlbumTracks(String(albumId), { fetchAll: false, limit: opts.limit || 10 });
      return (res?.items || []).slice(0, opts.limit || 10).map(mapToSimple).filter(Boolean);
    }
    const client = await getClient();
    const res = await client.getAlbumTracks(String(albumId), { fetchAll: false, limit: opts.limit || 10 });
    return (res.items || []).slice(0, opts.limit || 10).map(mapToSimple).filter(Boolean);
  } catch (e) {
    console.warn('fetchAlbumTracks error', e);
    return undefined;
  }
}

export async function fetchPlaylistTracks(playlistId: string | number, opts: { limit?: number } = {}): Promise<SimpleTrack[] | undefined> {
  const w: any = window;
  try {
    if (w.electron?.spotify?.getPlaylistTracks) {
      const res = await w.electron.spotify.getPlaylistTracks(String(playlistId));
      return (res?.items || []).slice(0, opts.limit || 10).map((it: any) => mapToSimple(it.track)).filter(Boolean);
    }
    const client = await getClient();
    const res = await client.getPlaylist(String(playlistId));
    return (res.tracks || []).slice(0, opts.limit || 10).map(mapToSimple).filter(Boolean);
  } catch (e) {
    console.warn('fetchPlaylistTracks error', e);
    return undefined;
  }
}

export async function fetchArtistTracks(artistId: string | number, opts: { limit?: number } = {}): Promise<SimpleTrack[] | undefined> {
  const w: any = window;
  try {
    // Prefer top-tracks for artist (good UX). Try electron IPC first.
    if (w.electron?.spotify?.getArtistTopTracks) {
      const res = await w.electron.spotify.getArtistTopTracks(String(artistId));
      return (res || []).slice(0, opts.limit || 10).map(mapToSimple).filter(Boolean);
    }
    const client = await getClient();
    const res = await client.getArtistTopTracks(String(artistId));
    return (res || []).slice(0, opts.limit || 10).map(mapToSimple).filter(Boolean);
  } catch (e) {
    console.warn('fetchArtistTracks error', e);
    return undefined;
  }
}

export default { fetchAlbumTracks, fetchPlaylistTracks, fetchArtistTracks };
