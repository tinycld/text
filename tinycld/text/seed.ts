import type PocketBase from 'pocketbase'

// Seed function invoked by core/scripts/seed-db.ts for the primary test org.
// Receives the authenticated `pb` client plus the user/org/user_org context
// so records can be owned correctly. Return nothing; throw to abort the seed.
//
// Example:
//
//     await pb.collection('text_items').create({
//         name: 'Sample',
//         owner: userOrg.id,
//     })

interface SeedContext {
    user: { id: string; email: string; name: string }
    org: { id: string }
    userOrg: { id: string }
}

export default async function seed(_pb: PocketBase, _ctx: SeedContext): Promise<void> {
    // Add your sample data here.
}
