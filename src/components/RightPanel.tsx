import React, { useState } from 'react'
import MoreFromArtist from './MoreFromArtist'
import QueueTab from './QueueTab'
import useArtistBuckets from '../core/hooks/useArtistBuckets'
import { useI18n } from '../core/i18n'

export default function RightPanel({ collapsed, onToggle, width, activeRightTab, onRightTabChange, extraClass, onSelectAlbum, onSelectPlaylist }: { collapsed: boolean, onToggle: () => void, width?: number, activeRightTab?: string, onRightTabChange?: (t: string)=>void, extraClass?: string, onSelectAlbum?: (id:string)=>void, onSelectPlaylist?: (id:string)=>void }){
  const [internalTab, setInternalTab] = useState('artist');
  const tab = activeRightTab || internalTab;
  const setTab = (t: string) => { if(onRightTabChange) onRightTabChange(t); if(!activeRightTab) setInternalTab(t); };
  const { buckets, currentTrack } = useArtistBuckets();
  const { t } = useI18n();

  return (
  <aside className={`main-panels right-panel ${collapsed ? 'collapsed' : ''} ${extraClass||''}`} style={!collapsed && width ? { width } : undefined}>
  <div className="panel-header">
        <button
          type="button"
          className="panel-collapse-toggle right-panel-toggle"
          onClick={onToggle}
          aria-label={collapsed ? t('panel.expand','Expand') : t('panel.collapse','Collapse')}
          title={collapsed ? t('panel.expand','Expand') : t('panel.collapse','Collapse')}>
          <span className="material-symbols-rounded" style={{fontSize:20}}>{collapsed ? 'right_panel_open' : 'right_panel_close'}</span>
        </button>
        {!collapsed && <h4 className="panel-title" style={{margin:0}}>{tab === 'artist' ? t('artist.moreFrom') : t('queue.title')}</h4>}
      </div>
      <div className="right-tabs-body">
        {tab === 'artist' && (
          <MoreFromArtist
            collapsed={collapsed}
            buckets={buckets}
            currentArtistName={currentTrack?.artists?.[0]?.name}
            onSelectAlbum={onSelectAlbum}
            onSelectPlaylist={onSelectPlaylist}
          />
        )}
        {tab === 'queue' && (
          <QueueTab collapsed={collapsed} />
        )}
      </div>
    </aside>
  )
}