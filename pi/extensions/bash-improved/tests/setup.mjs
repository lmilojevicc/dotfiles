// Suite-specific environment on top of _test-support/register-loader.mjs: extension.test.ts runs real
// commands, which the bash tool would otherwise hold for its 30-second output wait.
process.env.PI_BASH_WAIT_SECONDS ??= "1";
