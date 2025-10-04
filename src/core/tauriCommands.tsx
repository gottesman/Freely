import { invoke } from "@tauri-apps/api/core";
import { frontendLogger } from './FrontendLogger';

// Type definitions for better type safety
type TauriInvokeFunction = (cmd: string, args?: any) => Promise<any>;
type TauriError = { error: string; message: string };
type TauriResult<T> = T | TauriError | false;

// Performance constants
const CACHE_CONSTANTS = {
  MAX_INFLIGHT_SIZE: 50,
  CLEANUP_THRESHOLD: 100
} as const;

// Cached invoke function to avoid repeated discovery
let cachedInvoke: TauriInvokeFunction | null = null;
let invokeSearchComplete = false;

// Global inflight cache with size management
const inflightCache = new Map<string, Promise<any>>();

// Optimized window access
const windowRef = typeof window !== 'undefined' ? (window as any) : {};

/**
 * Efficiently discover and cache the Tauri invoke function
 */
function findInvokeFunction(): TauriInvokeFunction | null {
  if (invokeSearchComplete) return cachedInvoke;

  // Helper to check and bind function if available
  const checkAndBind = (obj: any, path: string[]): TauriInvokeFunction | null => {
    let current = obj;
    for (const prop of path) {
      current = current?.[prop];
      if (!current) return null;
    }
    return typeof current === 'function' ? current.bind(obj) : null;
  };

  // Check various Tauri invoke locations in priority order
  const locations = [
    { obj: windowRef, path: ['tauri', 'invoke'] },
    { obj: windowRef, path: ['__TAURI__', 'invoke'] },
    { obj: windowRef, path: ['__TAURI__', 'core', 'invoke'] },
    { obj: windowRef, path: ['__TAURI__', 'tauri', 'invoke'] }
  ];

  for (const { obj, path } of locations) {
    const found = checkAndBind(obj, path);
    if (found) {
      cachedInvoke = found;
      invokeSearchComplete = true;
      return cachedInvoke;
    }
  }

  // Fallback to imported invoke function
  if (typeof invoke === 'function') {
    cachedInvoke = invoke as TauriInvokeFunction;
    invokeSearchComplete = true;
    return cachedInvoke;
  }

  frontendLogger.warn('Tauri invoke not found in this environment');
  invokeSearchComplete = true;
  return null;
}

/**
 * Generate efficient cache key for command deduplication
 */
function createCacheKey(command: string, args?: any): string {
  if (!args || Object.keys(args).length === 0) return command;
  
  // Fast path for simple args
  if (typeof args === 'string' || typeof args === 'number') {
    return `${command}::${args}`;
  }
  
  // Use JSON.stringify only when necessary
  try {
    return `${command}::${JSON.stringify(args)}`;
  } catch {
    // Fallback for non-serializable args
    return `${command}::${String(args)}`;
  }
}

/**
 * Clean up inflight cache when it gets too large
 */
function cleanupInflightCache(): void {
  if (inflightCache.size > CACHE_CONSTANTS.CLEANUP_THRESHOLD) {
    // Keep only the most recent entries (simple FIFO cleanup)
    const entries = Array.from(inflightCache.entries());
    const keepCount = CACHE_CONSTANTS.MAX_INFLIGHT_SIZE;
    const toKeep = entries.slice(-keepCount);
    
    inflightCache.clear();
    for (const [key, value] of toKeep) {
      inflightCache.set(key, value);
    }
  }
}

/**
 * Parse and normalize Tauri error responses
 */
function parseError(err: unknown): TauriError {
  // Handle string errors that might be JSON
  if (typeof err === 'string') {
    try {
      const parsed = JSON.parse(err);
      if (parsed && typeof parsed === 'object') {
        return {
          error: parsed.error || err,
          message: parsed.message || err
        };
      }
    } catch {
      // Fall through to default handling
    }
    return { error: err, message: err };
  }
  
  // Handle object errors
  if (err && typeof err === 'object') {
    const errorObj = err as any;
    return {
      error: errorObj.error || String(err),
      message: errorObj.message || String(err)
    };
  }
  
  // Fallback for other types
  const errorString = String(err);
  return { error: errorString, message: errorString };
}

/**
 * Optimized Tauri command execution with caching and error handling
 * 
 * Features:
 * - Automatic invoke function discovery and caching
 * - Request deduplication for identical commands
 * - Memory-efficient cache management
 * - Robust error handling and parsing
 * - Type-safe results
 * 
 * @param command - The Tauri command name to invoke
 * @param args - Optional arguments to pass to the command
 * @returns Promise resolving to command result, error object, or false if Tauri unavailable
 */
export async function runTauriCommand<T = any>(command: string, args?: any): Promise<TauriResult<T>> {
  // Get cached invoke function
  const invokeFunction = findInvokeFunction();
  if (!invokeFunction) {
    frontendLogger.warn('Tauri invoke not available in this environment');
    return false;
  }

  // Generate cache key for deduplication
  const cacheKey = createCacheKey(command, args);
  
  // Return existing inflight request if available
  if (inflightCache.has(cacheKey)) {
    return inflightCache.get(cacheKey)!;
  }

  // Cleanup cache if needed
  cleanupInflightCache();

  // Create and cache the promise
  const inflightPromise = (async (): Promise<TauriResult<T>> => {
    try {
      //frontendLogger.log(`[TauriCommands] Invoking command: ${command}`, args);
      const result = await invokeFunction(command, args ?? {});
      //frontendLogger.log(`[TauriCommands] Command ${command} result:`, result);
      return result as T;
    } catch (err) {
      frontendLogger.error(`[TauriCommands] Command ${command} error:`, err);
      return parseError(err);
    }
  })();

  inflightCache.set(cacheKey, inflightPromise);

  try {
    const result = await inflightPromise;
    return result;
  } finally {
    // Clean up completed request
    inflightCache.delete(cacheKey);
  }
}

/**
 * Check if Tauri is available in the current environment
 * @returns true if Tauri invoke function is available
 */
export function isTauriAvailable(): boolean {
  return findInvokeFunction() !== null;
}

/**
 * Get current inflight cache statistics for debugging
 * @returns Object with cache size and cleanup threshold info
 */
export function getTauriCacheStats(): { size: number; maxSize: number; cleanupThreshold: number } {
  return {
    size: inflightCache.size,
    maxSize: CACHE_CONSTANTS.MAX_INFLIGHT_SIZE,
    cleanupThreshold: CACHE_CONSTANTS.CLEANUP_THRESHOLD
  };
}

/**
 * Manually clear the inflight cache (useful for testing or cleanup)
 */
export function clearTauriCache(): void {
  inflightCache.clear();
}

/**
 * Type guard to check if a result is a Tauri error
 * @param result - The result to check
 * @returns true if the result is a TauriError
 */
export function isTauriError(result: any): result is TauriError {
  return result && typeof result === 'object' && 'error' in result && 'message' in result;
}

/**
 * Type guard to check if Tauri is unavailable (returns false)
 * @param result - The result to check
 * @returns true if Tauri was unavailable
 */
export function isTauriUnavailable(result: any): result is false {
  return result === false;
}

/**
 * Helper to extract successful result or throw on error
 * @param result - The Tauri command result
 * @returns The successful result
 * @throws Error if the result is an error or Tauri is unavailable
 */
export function unwrapTauriResult<T>(result: TauriResult<T>): T {
  if (isTauriUnavailable(result)) {
    throw new Error('Tauri is not available in this environment');
  }
  
  if (isTauriError(result)) {
    throw new Error(`Tauri command failed: ${result.message}`);
  }
  
  return result;
}

// Audio Settings Commands
export interface AudioDevice {
  id: number;
  name: string;
  driver: string;
  is_default: boolean;
  is_enabled: boolean;
  is_initialized: boolean;
}

export interface AudioSettings {
  device: number;
  sample_rate: number;
  bit_depth: number;
  buffer_size: number;
  net_buffer: number;
  volume: number;
  exclusive_mode: boolean;
  output_channels: number;
}

/**
 * Get available audio devices
 * @returns Promise resolving to list of audio devices
 */
export async function getAudioDevices(): Promise<{ devices: AudioDevice[] }> {
  const result = await runTauriCommand('get_audio_devices');
  return result;
}

/**
 * Get current audio settings
 * @returns Promise resolving to current audio settings
 */
export async function getAudioSettings(): Promise<{ settings: AudioSettings }> {
  const result = await runTauriCommand('get_audio_settings');
  return result;
}

/**
 * Update audio settings
 * @param settings - Partial audio settings to update
 * @returns Promise resolving to success status
 */
export async function setAudioSettings(settings: Partial<AudioSettings>): Promise<{ success: boolean; message: string; reinitialized?: boolean }> {
  // Pass settings wrapped under the `settings` key to match Rust command signature
  const result = await runTauriCommand('set_audio_settings', { settings });
  return result;
}

/**
 * Reinitialize audio with new device and settings
 * @param deviceId - Audio device ID
 * @param sampleRate - Sample rate in Hz
 * @param bufferSize - Buffer size
 * @returns Promise resolving to success status
 */
export async function reinitializeAudio(deviceId: number, sampleRate: number, bufferSize: number): Promise<{ success: boolean; message: string }> {
  const result = await runTauriCommand('reinitialize_audio', { 
    device_id: deviceId, 
    sample_rate: sampleRate, 
    buffer_size: bufferSize 
  });
  return result;
}

// Plugins API
export interface PluginInfo {
  name: string;
  version: string;
  provider?: string | null;
  type?: string | null;
  enabled: boolean;
}

export async function pluginsList(): Promise<PluginInfo[]> {
  const res = await runTauriCommand('plugins_list');
  return (res as any) ?? [];
}

export async function pluginsSetEnabled(name: string, enabled: boolean): Promise<boolean> {
  const res = await runTauriCommand('plugins_set_enabled', { payload: { name, enabled } });
  return !!(res as any)?.status;
}

export async function pluginsDelete(name: string): Promise<boolean> {
  const res = await runTauriCommand('plugins_delete', { name });
  return !!(res as any)?.status;
}

export async function pluginsInstallZipFromFile(file: File): Promise<boolean> {
  const buf = await file.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  const res = await runTauriCommand('plugins_install_zip', { payload: { base64_zip: base64 } });
  return !!(res as any)?.status;
}

// Script plugin sources
export interface ScriptPluginSource { name: string; provider?: string | null; entry: string; code: string; }
export async function pluginsScriptSources(): Promise<ScriptPluginSource[]> {
  const res = await runTauriCommand('plugins_script_sources');
  return (res as any) ?? [];
}