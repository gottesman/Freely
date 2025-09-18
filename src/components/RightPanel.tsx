import React, { useCallback, useMemo, useState } from 'react';
import MoreFromArtist from './MoreFromArtist';
import QueueTab from './QueueTab';
import DownloadsTab from './DownloadsTab';
import useArtistBuckets from '../core/hooks/useArtistBuckets';
import { useI18n } from '../core/i18n';

// Constants for better performance and maintainability
const PANEL_CONFIG = {
  iconSize: 20,
  defaultTab: 'artist' as const,
  tabs: {
    artist: 'artist',
    queue: 'queue',
    downloads: 'downloads'
  } as const
} as const;

// Proper TypeScript interface for props
interface RightPanelProps {
  collapsed: boolean;
  onToggle: () => void;
  width?: number;
  activeRightTab?: string;
  onRightTabChange?: (tab: string) => void;
  extraClass?: string;
  onSelectAlbum?: (id: string) => void;
  onSelectPlaylist?: (id: string) => void;
}

// Custom hook for tab management
function useTabManagement(activeRightTab?: string, onRightTabChange?: (tab: string) => void) {
  const [internalTab, setInternalTab] = useState<string>(PANEL_CONFIG.defaultTab);
  
  const currentTab = activeRightTab || internalTab;
  
  const setTab = useCallback((newTab: string) => {
    if (onRightTabChange) onRightTabChange(newTab);
    if (!activeRightTab) setInternalTab(newTab);
  }, [activeRightTab, onRightTabChange]);
  
  return { currentTab, setTab };
}

// Custom hook for panel styling
function usePanelStyles(collapsed: boolean, width?: number, extraClass?: string) {
  return useMemo(() => ({
    className: `main-panels right-panel ${collapsed ? 'collapsed' : ''} ${extraClass || ''}`,
    style: !collapsed && width ? { width } : undefined
  }), [collapsed, width, extraClass]);
}

// Memoized panel header component
const PanelHeader = React.memo<{
  collapsed: boolean;
  onToggle: () => void;
  currentTab: string;
  t: (key: string, fallback?: string) => string;
}>(({ collapsed, onToggle, currentTab, t }) => {
  const toggleLabel = collapsed ? t('panel.expand', 'Expand') : t('panel.collapse', 'Collapse');
  const panelTitle = currentTab === PANEL_CONFIG.tabs.artist 
    ? t('artist.moreFrom') 
    : currentTab === PANEL_CONFIG.tabs.queue
      ? t('queue.title')
      : t('downloads.title', 'Downloads');

  return (
    <div className="panel-header">
      <button
        type="button"
        className="panel-collapse-toggle right-panel-toggle"
        onClick={onToggle}
        aria-label={toggleLabel}
        title={toggleLabel}
      >
        <span 
          className="material-symbols-rounded" 
          style={{ fontSize: PANEL_CONFIG.iconSize }}
        >
          {collapsed ? 'right_panel_open' : 'right_panel_close'}
        </span>
      </button>
      {!collapsed && (
        <h4 className="panel-title" style={{ margin: 0 }}>
          {panelTitle}
        </h4>
      )}
    </div>
  );
});

// Memoized tab content component
const TabContent = React.memo<{
  currentTab: string;
  collapsed: boolean;
  buckets: any;
  currentArtistName?: string;
  onSelectAlbum?: (id: string) => void;
  onSelectPlaylist?: (id: string) => void;
}>(({ currentTab, collapsed, buckets, currentArtistName, onSelectAlbum, onSelectPlaylist }) => {
  if (currentTab === PANEL_CONFIG.tabs.artist) {
    return (
      <MoreFromArtist
        collapsed={collapsed}
        buckets={buckets}
        currentArtistName={currentArtistName}
        onSelectAlbum={onSelectAlbum}
        onSelectPlaylist={onSelectPlaylist}
      />
    );
  }
  
  if (currentTab === PANEL_CONFIG.tabs.queue) {
    return <QueueTab collapsed={collapsed} />;
  }
  if (currentTab === PANEL_CONFIG.tabs.downloads) {
    return <DownloadsTab collapsed={collapsed} />;
  }
  
  return null;
});

export default function RightPanel({
  collapsed,
  onToggle,
  width,
  activeRightTab,
  onRightTabChange,
  extraClass,
  onSelectAlbum,
  onSelectPlaylist
}: RightPanelProps) {
  const { currentTab, setTab } = useTabManagement(activeRightTab, onRightTabChange);
  const { buckets, currentTrack } = useArtistBuckets();
  const { t } = useI18n();
  const panelStyles = usePanelStyles(collapsed, width, extraClass);

  // Memoized current artist name for better performance
  const currentArtistName = useMemo(() => 
    currentTrack?.artists?.[0]?.name,
    [currentTrack?.artists]
  );

  return (
    <aside className={panelStyles.className} style={panelStyles.style}>
      <PanelHeader 
        collapsed={collapsed}
        onToggle={onToggle}
        currentTab={currentTab}
        t={t}
      />
      <div className="right-tabs-body">
        <TabContent
          currentTab={currentTab}
          collapsed={collapsed}
          buckets={buckets}
          currentArtistName={currentArtistName}
          onSelectAlbum={onSelectAlbum}
          onSelectPlaylist={onSelectPlaylist}
        />
      </div>
    </aside>
  );
}