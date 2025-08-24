import React from 'react'
import { useI18n } from '../core/i18n'
import { usePlaylists } from '../core/playlists'
import LeftPanelPlaylists from './LeftPanelPlaylists';
import LeftPanelArtists from './LeftPanelArtists';

export default function LeftPanel({ collapsed, onToggle, width, extraClass, onSelectPlaylist, activePlaylistId, onSelectArtist, onSelectArtistActiveId, activeArtistVisible }: { collapsed: boolean, onToggle: () => void, width?: number, extraClass?: string, onSelectPlaylist?: (id: string)=>void, activePlaylistId?: string, onSelectArtist?: (id: string)=>void, onSelectArtistActiveId?: string, activeArtistVisible?: boolean }){
  const { t } = useI18n();
  const { playlists } = usePlaylists();
  // Left panel main tab (collections). Future: could persist in local storage.
  const [tab, setTab] = React.useState<'playlists'|'artists'>('playlists');
  // Collapsed view needs a simple ordered playlist list
  const collapsedPlaylists = React.useMemo(()=>{
    return [...playlists].sort((a,b)=>{
      const aFav = a.system && a.code === 'favorites';
      const bFav = b.system && b.code === 'favorites';
      if(aFav && !bFav) return -1;
      if(bFav && !aFav) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [playlists]);

  // Render the same panel markup whether collapsed or expanded.
  // CSS selectors can target `.left-panel.collapsed` to hide/reduce content visually
  // while keeping the same DOM (and data) available for accessibility and logic.
  const asideClass = `main-panels left-panel ${extraClass||''} ${collapsed ? 'collapsed' : ''}`;
  const asideStyle = collapsed ? undefined : (width ? { width } : undefined);

  return (
  <aside className={asideClass} style={asideStyle}>
      <nav className="left-nav">
        <div className="panel-header">
          <h4 className="panel-title" style={{margin:0}}>{t('left.collections','Collections')}</h4>
          <button
            type="button"
            className="panel-collapse-toggle left-panel-toggle"
            onClick={onToggle}
            aria-label={t('panel.collapse','Collapse')}
            title={t('panel.collapse','Collapse')}>
            <span className="material-symbols-rounded" style={{fontSize:20}}>left_panel_close</span>
          </button>
        </div>
        <div className='left-tabs-buttons'>
          <button
            type='button'
            className={`np-pill ${tab==='playlists'?'active':''}`}
            aria-pressed={tab==='playlists'}
            onClick={()=> setTab('playlists')}
          >
            {t('pl.playlists','Playlists')}
          </button>
          <button
            type='button'
            className={`np-pill ${tab==='artists'?'active':''}`}
            aria-pressed={tab==='artists'}
            onClick={()=> setTab('artists')}
          >
            {t('ar.artists','Artists')}
          </button>
        </div>
  {tab==='playlists' && <LeftPanelPlaylists onSelectPlaylist={onSelectPlaylist} activePlaylistId={activePlaylistId} />}
  {tab==='artists' && <LeftPanelArtists onSelectArtist={onSelectArtist} activeArtistId={onSelectArtistActiveId} activeArtistVisible={activeArtistVisible} />}
      </nav>
    </aside>
  )
}
