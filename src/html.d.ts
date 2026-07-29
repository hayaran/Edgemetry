declare module '*.html' {
  const content: string;
  export default content;
}

/** Vite's `?raw` loader, used by test/demo.test.ts to evaluate the demo mock. */
declare module '*?raw' {
  const content: string;
  export default content;
}
