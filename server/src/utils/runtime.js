export const isTestMode = process.env.NODE_ENV === 'test'
  || Boolean(process.env.NODE_TEST_CONTEXT)
  || process.execArgv.includes('--test')
  || (process.env.NODE_ENV !== 'production' && Boolean(process.env.TEST_MODE));
