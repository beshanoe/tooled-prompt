import { tool, getToolMetadata,  } from './src/index.js';
import { z } from 'zod';

// Test tuple args
function copyFile(src: string, dest: string) {
  return `${src} -> ${dest}`;
}

const wrappedCopy = tool(copyFile, {
  description: 'Copy a file',
  args: z.tuple([
    z.string().describe('Source path'),
    z.string().describe('Destination path'),
  ]),
});

console.log('Tuple schema test:');
console.log(JSON.stringify(getToolMetadata(wrappedCopy), null, 2));

// Test with mixed types
function createUser(name: string, age: number) {
  return { name, age };
}

const wrappedCreate = tool(createUser, {
  args: z.tuple([
    z.string().describe('User name'),
    z.number().describe('User age'),
  ]),
});

console.log('\nMixed types tuple:');
console.log(JSON.stringify(getToolMetadata(wrappedCreate), null, 2));
