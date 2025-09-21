import React, { useCallback, useMemo, useState } from 'react';
import { useI18n } from '../core/i18n';
import LeftPanelPlaylists from './LeftPanel/Playlists';
import LeftPanelArtists from './LeftPanel/FollowedArtists';

// Constants for better performance and maintainability
const PANEL_CONFIG = {
  iconSize: 20,
  defaultTab: 'playlists' as const,
  tabs: {
    playlists: 'playlists',
    artists: 'artists'
  } as const
} as const;

// Type definitions
type TabType = 'playlists' | 'artists';

interface LeftPanelProps {
  collapsed: boolean;
  onToggle: () => void;
  width?: number;
  extraClass?: string;
  activePlaylistId?: string;
  onSelectArtistActiveId?: string;
  activeArtistVisible?: boolean;
}

// Custom hook for panel styling
function usePanelStyles(collapsed: boolean, width?: number, extraClass?: string) {
  return useMemo(() => ({
    className: `main-panels left-panel ${extraClass || ''} ${collapsed ? 'collapsed' : ''}`,
    style: collapsed ? undefined : (width ? { width } : undefined)
  }), [collapsed, width, extraClass]);
}

// Custom hook for tab management
function useTabManagement() {
  const [activeTab, setActiveTab] = useState<TabType>(PANEL_CONFIG.defaultTab);
  
  const handleTabChange = useCallback((tab: TabType) => {
    setActiveTab(tab);
  }, []);
  
  return { activeTab, handleTabChange };
}

// Memoized panel header component
const PanelHeader = React.memo<{
  collapsed: boolean;
  onToggle: () => void;
  t: (key: string, fallback?: string) => string;
}>(({ collapsed, onToggle, t }) => {
  const toggleLabel = t('panel.collapse', 'Collapse');
  
  return (
    <div className="panel-header">
      <h4 className="panel-title" style={{ margin: 0 }}>
        {t('left.collections', 'Collections')}
      </h4>
      <button
        type="button"
        className="panel-collapse-toggle left-panel-toggle"
        onClick={onToggle}
        aria-label={toggleLabel}
        title={toggleLabel}
      >
        <span 
          className="material-symbols-rounded" 
          style={{ fontSize: PANEL_CONFIG.iconSize }}
        >
          {collapsed ? 'left_panel_open' : 'left_panel_close'}
        </span>
      </button>
    </div>
  );
});

// Memoized tab buttons component
const TabButtons = React.memo<{
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  t: (key: string, fallback?: string) => string;
}>(({ activeTab, onTabChange, t }) => {
  const tabs = [
    { 
      key: PANEL_CONFIG.tabs.playlists, 
      label: t('pl.playlists', 'Playlists') 
    },
    { 
      key: PANEL_CONFIG.tabs.artists, 
      label: t('ar.artists', 'Artists') 
    }
  ] as const;

  return (
    <div className="left-tabs-buttons">
      {tabs.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          className={`np-pill ${activeTab === key ? 'active' : ''}`}
          aria-pressed={activeTab === key}
          onClick={() => onTabChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
});

// Memoized tab content component
const TabContent = React.memo<{
  activeTab: TabType;
  activePlaylistId?: string;
  onSelectPlaylist: (pid: string) => void;
  onSelectArtistActiveId?: string;
  activeArtistVisible?: boolean;
}>(({ activeTab, activePlaylistId, onSelectPlaylist, onSelectArtistActiveId, activeArtistVisible }) => {
  if (activeTab === PANEL_CONFIG.tabs.playlists) {
    return (
      <LeftPanelPlaylists 
        activePlaylistId={activePlaylistId} 
        onSelectPlaylist={onSelectPlaylist} 
      />
    );
  }
  
  if (activeTab === PANEL_CONFIG.tabs.artists) {
    return (
      <LeftPanelArtists 
        activeArtistId={onSelectArtistActiveId} 
        activeArtistVisible={activeArtistVisible} 
      />
    );
  }
  
  return null;
});
export default function LeftPanel({
  collapsed,
  onToggle,
  width,
  extraClass,
  activePlaylistId,
  onSelectArtistActiveId,
  activeArtistVisible
}: LeftPanelProps) {
  const { t } = useI18n();
  const { activeTab, handleTabChange } = useTabManagement();
  const panelStyles = usePanelStyles(collapsed, width, extraClass);

  // Optimized playlist selection handler
  const handleSelectPlaylist = useCallback((pid: string) => {
    try {
      window.dispatchEvent(new CustomEvent('freely:selectPlaylist', { 
        detail: { playlistId: pid, source: 'left-panel' } 
      }));
    } catch {
      // Silently ignore errors
    }
  }, []);

  return (
    <aside className={panelStyles.className} style={panelStyles.style}>
      <nav className="left-nav">
        <PanelHeader 
          collapsed={collapsed}
          onToggle={onToggle}
          t={t}
        />
        <TabButtons 
          activeTab={activeTab}
          onTabChange={handleTabChange}
          t={t}
        />
        <TabContent
          activeTab={activeTab}
          activePlaylistId={activePlaylistId}
          onSelectPlaylist={handleSelectPlaylist}
          onSelectArtistActiveId={onSelectArtistActiveId}
          activeArtistVisible={activeArtistVisible}
        />
      </nav>
    </aside>
  );
}
