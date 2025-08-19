import React, { useState } from 'react'
import MoreFromArtist from './MoreFromArtist'
import QueueTab from './QueueTab'
import useArtistBuckets from '../core/hooks/useArtistBuckets'
import { useI18n } from '../core/i18n'

export default function RightPanel({ collapsed, onToggle, width, activeRightTab, onRightTabChange, extraClass }: { collapsed: boolean, onToggle: () => void, width?: number, activeRightTab?: string, onRightTabChange?: (t: string)=>void, extraClass?: string }){
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
      </div>
      <div className="right-tabs-body">
        {tab === 'artist' && (
          <MoreFromArtist collapsed={collapsed} buckets={buckets} currentArtistName={currentTrack?.artists?.[0]?.name} />
        )}
        {tab === 'queue' && (
          <QueueTab collapsed={collapsed} />
        )}
      </div>
    </aside>
  )
}