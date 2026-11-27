export const mathJaxVersion = '4.1.3';
export const mathJaxPath = 'mathjax/' + mathJaxVersion + '/';
export const mathJaxEntry = 'startup.js';

// Browser component bytes from the exact npm versions in package-lock.json.
export const mathJaxScripts: Readonly<Record<string, string>> = {
  [mathJaxEntry]: '13a303eae8790c5c79eddb2afdd3d22338be6fe59e0b526ebc92d00b88d98a1d',
  'core.js': '1a3cb32a18199355c67b8f78f57598dec8c253f7455ae42ac3f974b548d43a1b',
  'input/tex-base.js': '3333576887732af3f4d43ff259f5e5bb412efb4717c454f49182a462c80a5da8',
  'input/tex/extensions/newcommand.js': '27bc6df0fc8567eaff5153e679e5de53e9cf0918aae714d8dd72fd3a40ca2293',
  'input/tex/extensions/ams.js': '6ff85ab489da04ec533a22b9b93d5d5d51f9f51ef02c723439734e65d9257d14',
  'output/svg.js': '6151d21b8205858c103642484f1ca272e3c9cbbde37d53235ac0572966ce613d',
  'ui/safe.js': 'ddd5b5eb3076bdf71c9b0508c58fae095b441a22b7bf2ff2e1ad5ace389f49b2',
  'fonts/mathjax-tex-font/svg.js': 'ed5c78819c63883579fb8a4bcec97a2a2fe32e8a0a7f504273aeece0ca396a33',
};
