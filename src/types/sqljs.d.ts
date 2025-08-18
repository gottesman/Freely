declare module 'sql.js' {
  function initSqlJs(opts?: any): Promise<any>;
  export default initSqlJs;
}
// Extend global window typing for preload exposed APIs
declare global {
  interface Window {
    electron?: {
      window?: {
        minimize(): void;
        maximize(): void;
        restore(): void;
        close(): void;
        isMaximized(): Promise<boolean>;
        onMaximizeChanged(cb: (isMax: boolean) => void): void;
      };
      genius?: {
        search(query: string): Promise<{ query: string; hits: Array<{ id:number; title:string; fullTitle:string; url:string; songArtImageUrl?:string; headerImageUrl?:string; primaryArtist?: { id:number; name:string } }> }>;
  getSong(id: number): Promise<any>;
  getArtist(id: number): Promise<any>;
  getAlbum(id: number): Promise<any>;
  getLyrics(id: number): Promise<any>;
      }
      spotify?: {
  search(query: string, types?: string|string[]): Promise<{ query: string; types: string[]; results: Record<string, any[]> }>;
        getTrack(id: string): Promise<any>;
        getAlbum(id: string): Promise<any>;
        getArtist(id: string): Promise<any>;
  getAlbumTracks(id: string, opts?: { limit?: number; fetchAll?: boolean; maxPages?: number }): Promise<{ albumId: string; total: number; items: any[]; raw: any[] }>;
      }
    }
  }
}
