import { createContext, useContext } from 'react';
import type { PlatformCapabilities } from '../shared/types';

export const unavailablePlatform: PlatformCapabilities = { platform: 'unknown', folderPicker: false, revealFolder: false, externalApps: false };
export const PlatformContext = createContext<PlatformCapabilities>(unavailablePlatform);
export const usePlatform = () => useContext(PlatformContext);
