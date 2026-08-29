const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let currentLevel = LEVELS.info;

export function setLogLevel(level) {
  currentLevel = LEVELS[level] ?? LEVELS.info;
}

export function getLogLevel() {
  return Object.keys(LEVELS).find((k) => LEVELS[k] === currentLevel) ?? 'info';
}

export function createLogger(scope) {
  const emit = (level, args) => {
    if (LEVELS[level] < currentLevel) return;
    const fn = level === 'debug' ? console.debug : console[level] ?? console.log;
    fn(`%c[AusoPhone:${scope}]`, 'color:#0a7', ...args);
  };
  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
  };
}
