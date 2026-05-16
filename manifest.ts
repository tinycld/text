const manifest = {
    name: 'Text',
    slug: 'text',
    version: '0.1.0',
    description: 'Plain-text and rich-text documents.',
    routes: { directory: 'screens' },
    nav: {
        label: 'Text',
        icon: 'file-text',
        order: 15,
        shortcut: 't',
    },
    sidebar: { component: 'sidebar' },
    provider: { component: 'provider' },
    migrations: { directory: 'pb-migrations' },
    collections: { register: 'collections', types: 'types' },
    server: { package: 'server', module: 'tinycld.org/packages/text' },
    dependencies: ['drive'],
}

export default manifest
