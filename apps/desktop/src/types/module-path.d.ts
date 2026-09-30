/**
 * electron-vite turns `import x from './entry?modulePath'` into "build this file as a
 * separate entry and give me the path to the bundle". That is how the scan host becomes a
 * real `utilityProcess` target without hardcoding an output path that differs between
 * `electron-vite dev` and a packaged build.
 */
declare module '*?modulePath' {
  const modulePath: string;
  export default modulePath;
}
