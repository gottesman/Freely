import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useI18n } from '../core/i18n';

// Constants for better performance
const NAV_BUTTONS = [
  { id: 'home', icon: 'home', key: 'nav.home' },
  { id: 'settings', icon: 'settings', key: 'nav.settings' },
  { id: 'apis', icon: 'terminal', key: 'nav.dev' },
] as const;

const WINDOW_BUTTONS = [
  { id: 'minimize', symbol: '—', key: 'window.minimize' },
  { id: 'maximize', symbol: '▢', key: 'window.maximize' },
  { id: 'restore', symbol: '❐', key: 'window.restore' },
  { id: 'close', symbol: '✕', key: 'window.close' },
] as const;

// Optimized props interface
interface TitleBarProps {
  title?: string;
  icon?: string;
  onSearch?: (query: string) => void;
  onNavigate?: (destination: string) => void;
  activeTab?: string;
  windowStatus: {
    maximize: () => void;
    restore: () => void;
    minimize: () => void;
    close: () => void;
  };
  isMaximized: boolean;
}

// Memoized navigation button component
const NavButton = React.memo(({ 
  id, 
  icon, 
  label, 
  isActive, 
  onClick 
}: {
  id: string;
  icon: string;
  label: string;
  isActive: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    className={`tb-nav-btn ${isActive ? 'active' : ''}`}
    aria-label={label}
    title={label}
    onClick={onClick}
  >
    <span className="material-symbols-rounded filled">{icon}</span>
  </button>
));

NavButton.displayName = 'NavButton';

// Memoized window button component
const WindowButton = React.memo(({ 
  symbol, 
  label, 
  className, 
  onClick 
}: {
  symbol: string;
  label: string;
  className: string;
  onClick: () => void;
}) => (
  <button
    className={`tb-btn ${className}`}
    onClick={onClick}
    aria-label={label}
  >
    {symbol}
  </button>
));

WindowButton.displayName = 'WindowButton';

export default function TitleBar({
  title,
  icon,
  onSearch,
  onNavigate,
  activeTab,
  windowStatus: { maximize, restore, minimize, close },
  isMaximized
}: TitleBarProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Memoized resolved title
  const resolvedTitle = useMemo(() => title || t('app.title'), [title, t]);

  // Optimized event handlers with useCallback
  const handleNavigate = useCallback((destination: string) => {
    onNavigate?.(destination);
  }, [onNavigate]);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    onSearch?.(value);
  }, [onSearch]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      onSearch?.(query);
    }
  }, [onSearch, query]);

  const handleSearchFocus = useCallback(() => {
    // Activate search tab and re-trigger current query
    onNavigate?.('search');
    if (query) {
      onSearch?.(query);
    }
  }, [onNavigate, onSearch, query]);

  const handleSearchIconClick = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // Memoized navigation buttons
  const navigationButtons = useMemo(() => 
    NAV_BUTTONS.map(({ id, icon, key }) => (
      <NavButton
        key={id}
        id={id}
        icon={icon}
        label={t(key)}
        isActive={activeTab === id}
        onClick={() => handleNavigate(id)}
      />
    )), [t, activeTab, handleNavigate]);

  // Memoized window control buttons
  const windowControlButtons = useMemo(() => {
    const buttons = [
      { ...WINDOW_BUTTONS[0], className: 'tb-min', onClick: minimize },
      isMaximized 
        ? { ...WINDOW_BUTTONS[2], className: 'tb-restore', onClick: restore }
        : { ...WINDOW_BUTTONS[1], className: 'tb-max', onClick: maximize },
      { ...WINDOW_BUTTONS[3], className: 'tb-close', onClick: close }
    ];

    return buttons.map(({ symbol, key, className, onClick }) => (
      <WindowButton
        key={className}
        symbol={symbol}
        label={t(key)}
        className={className}
        onClick={onClick}
      />
    ));
  }, [isMaximized, t, minimize, restore, maximize, close]);

  // Memoized search container class
  const searchContainerClass = useMemo(() => 
    `titlebar-search${activeTab === 'search' ? ' search-active' : ''}`,
    [activeTab]
  );

  return (
    <div className="titlebar">
      <div className="titlebar-left">
        {icon ? (
          <div className="titlebar-icon" style={{ backgroundImage: `url(${icon})` }} />
        ) : (
          <div className="titlebar-icon placeholder" />
        )}
        <div className="titlebar-title">{resolvedTitle}</div>
      </div>

      <div className="titlebar-nav">
        {navigationButtons}
        <div className={searchContainerClass}>
          <span
            className="tb-search-icon material-symbols-rounded"
            onClick={handleSearchIconClick}
            role="button"
            aria-label={t('search.focus', 'Focus search')}
          >
            search
          </span>
          <input
            ref={inputRef}
            className="tb-search"
            placeholder={t('search.placeholder')}
            value={query}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            onFocus={handleSearchFocus}
            aria-label={t('search.action', 'Search')}
          />
        </div>
      </div>

      <div className="titlebar-right titlebar-window-buttons">
        {windowControlButtons}
      </div>
    </div>
  );
}
