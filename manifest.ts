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
    seed: { script: 'seed' },
}

export default manifest
