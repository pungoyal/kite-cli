import { defineConfig } from 'vitepress';

const repo = 'https://github.com/pungoyal/kite-cli';

// The site is served from a project GitHub Pages path, so every asset URL is
// prefixed with the repo name. `cleanUrls` drops the `.html` suffix — GitHub
// Pages resolves the extensionless URL to the generated file.
export default defineConfig({
  lang: 'en-GB',
  title: 'kite-cli',
  description: 'Unofficial, secure, scriptable CLI for the Zerodha Kite Connect v3 API.',
  base: '/kite-cli/',
  cleanUrls: true,
  lastUpdated: true,
  // The docs deliberately link to source files and README anchors with
  // absolute github.com URLs (they live outside the site), so there are no
  // in-site dead links to police — but keep the check on to catch typos in
  // cross-page links.
  ignoreDeadLinks: false,
  themeConfig: {
    nav: [
      {
        text: 'Reference',
        items: [
          { text: 'Command reference', link: '/commands' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Safety model', link: '/safety' },
          { text: 'MCP server', link: '/mcp' },
          { text: 'Library API', link: '/api' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
      { text: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md` },
      { text: 'npm', link: 'https://www.npmjs.com/package/@pungoyal/kite-cli' },
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [{ text: 'Overview', link: '/' }],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Command reference', link: '/commands' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Safety model', link: '/safety' },
          { text: 'MCP server', link: '/mcp' },
          { text: 'Library API', link: '/api' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
    ],
    outline: 'deep',
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    footer: {
      message:
        'Unofficial, independent project — not affiliated with, endorsed by, or sponsored by Zerodha. Released under the MIT Licence.',
    },
  },
});
