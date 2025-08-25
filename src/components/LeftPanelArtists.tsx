import React from 'react';
import { useI18n } from '../core/i18n';
import useFollowedArtists from '../core/artists';

export default function LeftPanelArtists({ onSelectArtist, activeArtistId, activeArtistVisible }: { onSelectArtist?: (id: string)=>void, activeArtistId?: string, activeArtistVisible?: boolean }){
  const { t } = useI18n();
  const { artists, loading } = useFollowedArtists();

  // Debug logging for artists list changes
  React.useEffect(() => {
    console.log('[artists-debug] LeftPanelArtists artists updated, count=', artists.length, 'artists=', artists.map(a => a.name));
  }, [artists]);

  // The hook now provides optimistic updates & pub/sub; no local mirror needed.
  const list = artists;

  if(loading) return <div className='left-artists'><div className="left-artists-loading">{t('common.loading','Loading…')}</div></div>;

  if(!list || !list.length) return (
    <div className='left-artists'>
      <div className='left-artists-empty'>{t('ar.placeholder','No followed artists found')}</div>
    </div>
  );

  return (
    <div className='left-artists'>
      {list.map(a => {
        const img = (window as any).imageRes?.(a.images, 3);
        return (
          <button
            key={a.id}
            type="button"
            className={`artist-row card-btn ${(activeArtistVisible && String(a.id) === String(activeArtistId || '')) ? 'active' : ''}`}
            onClick={() => {
              try {
                if (onSelectArtist && a.id) onSelectArtist(a.id);
              } catch (e) {
                // ignore handler errors
              }
              // Robust fallback: dispatch a global event so higher-level listeners (App) can open the artist tab
              try { window.dispatchEvent(new CustomEvent('freely:select-artist', { detail: String(a.id) })); } catch(e){}
            }}
          >
            <div className='artist-avatar'>
              { img ? <img src={img} alt="" /> : <span className="material-symbols-rounded">person</span> }
            </div>
            <div className='artist-text'>
              <div className='artist-name'>{a.name}</div>
              <div className='artist-genres'>{a.genres?.slice(0,2).join(', ')}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
