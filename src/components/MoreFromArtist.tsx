import React from 'react';
import { useI18n } from '../core/i18n';
import type { SpotifyAlbum, SpotifyPlaylist } from '../core/spotify';

export interface ArtistBuckets {
  singles: SpotifyAlbum[];
  albums: SpotifyAlbum[];
  playlists: SpotifyPlaylist[];
  loading: boolean;
  error?: string;
  fetched?: boolean;
}

interface MoreFromArtistProps {
  buckets: ArtistBuckets;
  currentArtistName?: string;
  collapsed?: boolean;
}

function listSection(title: string, kind: keyof ArtistBuckets, buckets: ArtistBuckets){
  if(kind==='loading' || kind==='error') return null;
  const arr = buckets[kind] as (SpotifyAlbum|SpotifyPlaylist)[];
  if(!arr.length) return null;
  return (
    <div className="artist-shelf">
      <h5 className="shelf-title">{title}</h5>
      <ul className="shelf-cards" role="list">
        {arr.map(item => (
          <li key={item.id} className="shelf-card" title={item.name}>
            <button type="button" className="card-btn">
              <div className="card-img-wrap"><img src={(item as any).images?.[0]?.url || '/icon-192.png'} alt={item.name} loading="lazy" /></div>
              <div className="card-meta">
                <div className="card-name">{item.name}</div>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const MoreFromArtist: React.FC<MoreFromArtistProps> = ({ buckets, currentArtistName, collapsed }) => {
  const { t } = useI18n();
  if(collapsed){
    const map = new Map<string, { id:string; img?:string; name:string }>();
    ['singles','albums','playlists'].forEach((k:any)=>{
      const arr = (buckets as any)[k] as any[]|undefined;
      if(Array.isArray(arr)) arr.forEach(it=>{ if(!map.has(it.id)){ map.set(it.id,{ id:it.id, img:it.images?.[0]?.url, name:it.name }); } });
    });
    const list = Array.from(map.values());
    return (
      <div className="rt-panel collapsed" role="tabpanel" aria-label={t('artist.moreFrom')}>
        <div className="rt-header" style={{display:'flex', justifyContent:'center'}}>
          <h4 className="panel-title" style={{margin:0}}>
            <span className="material-symbols-rounded gradient-icon" aria-hidden="true">artist</span>
          </h4>
        </div>
        <div className="collapsed-thumb-list" role="list">
          {list.map(it=>(
            <div key={it.id} className="collapsed-thumb-item" title={it.name}>
              <div className="collapsed-thumb" aria-hidden="true">
                {it.img ? <img src={it.img} alt="" loading="lazy" style={{width:'100%',height:'100%',objectFit:'cover'}}/> : it.name.slice(0,2).toUpperCase()}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="rt-panel" role="tabpanel" aria-label={t('artist.suggestions','Artist suggestions')}>
      <div className="rt-header">
        <h4 className="panel-title">{t('artist.moreFrom')}</h4>
        <div className="rt-subheading">
          <span className="rt-artist-name">{currentArtistName || t('artist.unknown','Artist')}</span>
        </div>
      </div>
      {buckets.loading && <div className="rt-placeholder">{t('artist.loadingReleases')}</div>}
      {buckets.fetched && !buckets.loading && !buckets.error && !buckets.albums.length && !buckets.singles.length && <div className="rt-placeholder">{t('artist.noReleases')}</div>}
      {listSection(t('artist.singles'), 'singles', buckets)}
      {listSection(t('artist.albums'), 'albums', buckets)}
      {listSection(t('artist.playlists'), 'playlists', buckets)}
    </div>
  );
};

export default MoreFromArtist;
