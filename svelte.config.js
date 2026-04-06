import adapter from '@sveltejs/adapter-static';
import { relative, sep } from 'node:path';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		runes: ({ filename }) => {
			const relativePath = relative(import.meta.dirname, filename);
			const pathSegments = relativePath.toLowerCase().split(sep);
			return pathSegments.includes('node_modules') ? undefined : true;
		}
	},
	kit: {
		adapter: adapter({ fallback: '200.html' }),
		prerender: { entries: [] }
	}
};

export default config;
