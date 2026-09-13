const normalizeMode = (value: unknown) => String(value || '').trim().toUpperCase();

export const getModSituation = () => normalizeMode(process.env.MOD_SITUATION) || 'PRODUCTION';

export const isSandboxMode = () => getModSituation() === 'SANDBOX';

export const shouldRunAutomaticProcesses = () => !isSandboxMode();
