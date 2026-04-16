Get Started with Drizzle and PostgreSQL
This guide assumes familiarity with:

    dotenv - package for managing environment variables - read here
    tsx - package for running TypeScript files - read here
    node-postgres - package for querying your PostgreSQL database - read here

Drizzle has native support for PostgreSQL connections with the node-postgres and postgres.js drivers.

We will use node-postgres for this get started example. But if you want to find more ways to connect to postgresql check our PostgreSQL Connection page
Basic file structure

This is the basic file structure of the project. In the src/db directory, we have table definition in schema.ts. In drizzle folder there are sql migration file and snapshots.

📦 <project root>
├ 📂 drizzle
├ 📂 src
│   ├ 📂 db
│   │  └ 📜 schema.ts
│   └ 📜 index.ts
├ 📜 .env
├ 📜 drizzle.config.ts
├ 📜 package.json
└ 📜 tsconfig.json

Step 1 - Install node-postgres package

pnpm add drizzle-orm pg dotenv
pnpm add -D drizzle-kit tsx @types/pg

Step 2 - Setup connection variables

Create a .env file in the root of your project and add your database connection variable:

DATABASE_URL=

tips

If you don’t have a PostgreSQL database yet and want to create one for testing, you can use our guide on how to set up PostgreSQL in Docker.

The PostgreSQL in Docker guide is available here. Go set it up, generate a database URL (explained in the guide), and come back for the next steps
Step 3 - Connect Drizzle ORM to the database

Create a index.ts file in the src directory and initialize the connection:

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';

const db = drizzle(process.env.DATABASE_URL!);

Step 4 - Create a table

Create a schema.ts file in the src/db directory and declare your table:
src/db/schema.ts

import { integer, pgTable, varchar } from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
id: integer().primaryKey().generatedAlwaysAsIdentity(),
name: varchar({ length: 255 }).notNull(),
age: integer().notNull(),
email: varchar({ length: 255 }).notNull().unique(),
});

Step 5 - Setup Drizzle config file

Drizzle config - a configuration file that is used by Drizzle Kit and contains all the information about your database connection, migration folder and schema files.

Create a drizzle.config.ts file in the root of your project and add the following content:
drizzle.config.ts

import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
out: './drizzle',
schema: './src/db/schema.ts',
dialect: 'postgresql',
dbCredentials: {
url: process.env.DATABASE_URL!,
},
});

Step 6 - Applying changes to the database

You can directly apply changes to your database using the drizzle-kit push command. This is a convenient method for quickly testing new schema designs or modifications in a local development environment, allowing for rapid iterations without the need to manage migration files:

npx drizzle-kit push

Read more about the push command in documentation.
Tips

Alternatively, you can generate migrations using the drizzle-kit generate command and then apply them using the drizzle-kit migrate command:

Generate migrations:

npx drizzle-kit generate

Apply migrations:

npx drizzle-kit migrate

Read more about migration process in documentation.
Step 7 - Seed and Query the database

Let’s update the src/index.ts file with queries to create, read, update, and delete users
src/index.ts

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { usersTable } from './db/schema';

const db = drizzle(process.env.DATABASE_URL!);

async function main() {
const user: typeof usersTable.$inferInsert = {
name: 'John',
age: 30,
email: 'john@example.com',
};

await db.insert(usersTable).values(user);
console.log('New user created!')

const users = await db.select().from(usersTable);
console.log('Getting all users from the database: ', users)
/*
const users: {
id: number;
name: string;
age: number;
email: string;
}[]
*/

await db
.update(usersTable)
.set({
age: 31,
})
.where(eq(usersTable.email, user.email));
console.log('User info updated!')

await db.delete(usersTable).where(eq(usersTable.email, user.email));
console.log('User deleted!')
}

main();

Step 8 - Run index.ts file

To run any TypeScript files, you have several options, but let’s stick with one: using tsx

You’ve already installed tsx, so we can run our queries now

Run index.ts script

pnpm tsx src/index.ts

tips

We suggest using bun to run TypeScript files. With bun, such scripts can be executed without issues or additional settings, regardless of whether your project is configured with CommonJS (CJS), ECMAScript Modules (ESM), or any other module format. To run a script with bun, use the following command:

bun src/index.ts

If you don’t have bun installed, check the Bun installation docs
