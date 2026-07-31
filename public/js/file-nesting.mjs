/**
 * file-nesting.mjs — File nesting rules and grouping logic.
 *
 * Ported from antfu/vscode-file-nesting-config.
 * Rules define which files should be visually nested under a parent file.
 *
 * Format: { parentPattern: "childPattern1, childPattern2, ..." }
 * - parentPattern matches the parent file name
 * - childPatterns match files that should nest under it
 * - $(capture) in child patterns is replaced by parent filename without extension
 * - Patterns are case-insensitive
 */

import { globMatchAny } from './glob.mjs';

// ─── Nesting Rules ────────────────────────────────────────────────

export const NESTING_RULES = {
  // ── Config files ──
  'package.json': '.browserslist*, .commitlint*, .cspell*, .cz-config.js, .czrc, .dlint.json, .dprint.json*, .editorconfig, .eslint*, .firebase*, .flowconfig, .github*, .gitlab*, .gitpod*, .huskyrc*, .knip.*, .lintstagedrc*, .markdownlint*, .node-version, .nodemon*, .npm*, .nvmrc, .oxfmtrc.json, .oxlintrc.json, .pm2*, .pnpm*, .prettier*, .pylintrc, .release-please*.json, .releaserc*, .ruff.toml, .sentry*, .shellcheckrc, .simple-git-hooks*, .stylelint*, .swcrc, .tazerc*, .textlint*, .tool-versions, .travis*, .versionrc*, .vscode*, .watchman*, .windsurfrules, .xo-config*, .yamllint*, .yarnrc*, Procfile, alejandra.toml, apollo.config.*, appveyor*, azure-pipelines*, biome.json*, bower.json, build.config.*, bun.lock, bun.lockb, bunfig.toml, commitlint*, crowdin*, cspell*, cz.config.*, dangerfile*, dlint.json, dprint.json*, eslint*, firebase.json, grunt*, gulp*, jenkins*, knip.*, lefthook.*, lerna*, lint-staged*, nest-cli.*, netlify*, nixpacks*, nodemon*, npm-shrinkwrap.json, nx.*, oxfmt.config.*, oxlint.config.*, package-lock.json, package.nls*.json, phpcs.xml, pm2.*, pnpm*, prettier*, pullapprove*, pyrightconfig.json, release-please*.json, release.config.*, renovate*, rolldown.config.*, rollup.config.*, rspack*, ruff.toml, sentry.*.config.ts, simple-git-hooks*, sonar-project.properties, stylelint*, taze.config.*, tsdown.config.*, tslint*, tsup.config.*, turbo*, typedoc*, unlighthouse*, vercel*, vetur.config.*, webpack*, workspace.json, wrangler.*, xo.config.*, yarn*',
  'tsconfig.json': 'tsconfig*.tsbuildinfo, tsconfig.*.json',
  '.gitignore': '.gitattributes, .gitmodules, .gitmessage, .lfsconfig, .mailmap, .git-blame*',
  '.clang-tidy': '.clang-format, .clangd, compile_commands.json',
  '.env': '*.env, .env.*, .envrc, env.d.ts',

  // ── Agent configs ──
  'AGENTS.md': '.clinerules, .cursorrules, .replit.md, .windsurfrules, AGENT.md, CLAUDE.local.md, CLAUDE.md, GEMINI.md',
  '.agent': '.claude, .cline, .codebuddy, .codex, .commandcode, .continue, .crush, .cursor, .factory, .gemini, .goose, .junie, .kilocode, .kiro, .kode, .mcpjam, .mux, .neovate, .opencode, .openhands, .pi, .pochi, .qoder, .qwen, .roo, .trae, .windsurf, .zencoder',

  // ── Docker ──
  'Dockerfile': '*.dockerfile, .devcontainer.*, .dockerignore, Dockerfile*, captain-definition, compose.*, docker-compose.*, dockerfile*',

  // ── Readme / docs ──
  'readme*': 'AUTHORS, BACKERS*, CHANGELOG*, CITATION*, CODEOWNERS, CODE_OF_CONDUCT*, CONTRIBUTING*, CONTRIBUTORS, COPYING*, CREDITS, GOVERNANCE.MD, HISTORY.MD, LICENSE, LICENSE.MD, LICENSE.txt, MAINTAINERS, README-*, README_*, RELEASE_NOTES*, ROADMAP.MD, SECURITY.MD, SPONSORS*, changelog*, citation*, code_of_conduct*, codeowners, contributing*, contributors, copying*, credits, governance.md, history.md, license, license.md, license.txt, maintainers, readme-*, readme_*, release_notes*, roadmap.md, security.md, sponsors*',

  // ── Go ──
  'go.mod': '.air*, go.sum',
  'go.work': 'go.work.sum',

  // ── Rust ──
  'Cargo.toml': '.clippy.toml, .rustfmt.toml, Cargo.Bazel.lock, Cargo.lock, clippy.toml, cross.toml, insta.yaml, rust-toolchain.toml, rustfmt.toml',

  // ── Python ──
  'pyproject.toml': '.editorconfig, .flake8, .isort.cfg, .python-version, MANIFEST.in, Pipfile, Pipfile.lock, requirements*.in, requirements*.pip, requirements*.txt, setup.cfg, setup.py, tox.ini, pdm.lock, poetry.lock, poetry.toml, uv.lock, uv.toml, .pdm-python, .pdm.toml',
  'requirements.txt': '.editorconfig, .flake8, .isort.cfg, .python-version, requirements*.in, requirements*.pip, tox.ini',
  'setup.cfg': '.editorconfig, .flake8, .isort.cfg, .python-version, MANIFEST.in, requirements*.in, requirements*.pip, requirements*.txt, tox.ini',
  'setup.py': '.editorconfig, .flake8, .isort.cfg, .python-version, MANIFEST.in, requirements*.in, requirements*.pip, requirements*.txt, setup.cfg, tox.ini',
  'Pipfile': '.editorconfig, .flake8, .isort.cfg, .python-version, Pipfile.lock, requirements*.in, requirements*.pip, requirements*.txt, tox.ini',

  // ── Java / Gradle ──
  'build.gradle': 'settings.gradle, gradlew, gradlew.bat, gradle.properties, gradle.lockfile',
  'build.gradle.kts': 'settings.gradle.kts, gradlew, gradlew.bat, gradle.properties, gradle.lockfile',
  'pom.xml': 'mvnw*',

  // ── PHP / Composer ──
  'composer.json': '.php*.cache, composer.lock, phpunit.xml*, psalm*.xml',
  'artisan': '*.env, .babelrc*, .codecov, .cssnanorc*, .env.*, .envrc, .htmlnanorc*, .lighthouserc.*, .mocha*, .postcssrc*, .terserrc*, api-extractor.json, ava.config.*, babel.config.*, capacitor.config.*, content.config.*, contentlayer.config.*, cssnano.config.*, cypress.*, env.d.ts, formkit.config.*, formulate.config.*, histoire.config.*, htmlnanorc.*, i18n.config.*, ionic.config.*, jasmine.*, jest.config.*, jsconfig.*, karma*, lighthouserc.*, panda.config.*, playwright.config.*, postcss.config.*, puppeteer.config.*, react-router.config.*, rspack.config.*, server.php, sst.config.*, svgo.config.*, tailwind.config.*, tsconfig.*, tsdoc.*, uno.config.*, unocss.config.*, vitest.config.*, vuetify.config.*, webpack.config.*, webpack.mix.js, windi.config.*',

  // ── Ruby ──
  'gemfile': '.ruby-version, gemfile.lock',
  'mix.exs': '.credo.exs, .dialyzer_ignore.exs, .formatter.exs, .iex.exs, .tool-versions, mix.lock',

  // ── .NET ──
  '*.csproj': '*.config, *proj.user, appsettings.*, bundleconfig.json, packages.lock.json',
  '*.fsproj': '*.config, *proj.user, appsettings.*, bundleconfig.json, packages.lock.json',
  '*.vbproj': '*.config, *proj.user, appsettings.*, bundleconfig.json, packages.lock.json',

  // ── C/C++ ──
  '*.c': '$(capture).h',
  '*.cc': '$(capture).hpp, $(capture).h, $(capture).hxx, $(capture).hh',
  '*.cpp': '$(capture).hpp, $(capture).h, $(capture).hxx, $(capture).hh',
  '*.cxx': '$(capture).hpp, $(capture).h, $(capture).hxx, $(capture).hh',

  // ── JavaScript / TypeScript ──
  '*.js': '$(capture).js.map, $(capture).*.js, $(capture)_*.js, $(capture).d.ts, $(capture).d.ts.map, $(capture).js.flow',
  '*.mjs': '$(capture).mjs.map, $(capture).*.mjs, $(capture)_*.mjs',
  '*.cjs': '$(capture).cjs.map, $(capture).*.cjs, $(capture)_*.cjs',
  '*.jsx': '$(capture).js, $(capture).*.jsx, $(capture)_*.js, $(capture)_*.jsx, $(capture).css, $(capture).module.css, $(capture).less, $(capture).module.less, $(capture).module.less.d.ts, $(capture).scss, $(capture).module.scss, $(capture).module.scss.d.ts',
  '*.ts': '$(capture).js, $(capture).d.ts.map, $(capture).*.ts, $(capture)_*.js, $(capture)_*.ts',
  '*.mts': '$(capture).mts.map, $(capture).*.mts, $(capture)_*.mts',
  '*.tsx': '$(capture).ts, $(capture).*.ts, $(capture).*.tsx, $(capture)_*.ts, $(capture)_*.tsx, $(capture).css, $(capture).module.css, $(capture).less, $(capture).module.less, $(capture).module.less.d.ts, $(capture).scss, $(capture).module.scss, $(capture).module.scss.d.ts, $(capture).css.ts',
  '*.vue': '$(capture).*.ts, $(capture).*.js, $(capture).story.vue',

  // ── Web / CSS ──
  '*.css': '$(capture).css.map, $(capture).*.css',
  '*.component.ts': '$(capture).component.html, $(capture).component.spec.ts, $(capture).component.css, $(capture).component.scss, $(capture).component.sass, $(capture).component.less',
  '*.module.ts': '$(capture).resolver.ts, $(capture).controller.ts, $(capture).service.ts',

  // ── Other languages ──
  '*.py': '$(capture).pyi',
  '*.go': '$(capture)_test.go',
  '*.java': '$(capture).class',
  '*.rb': '$(capture)_test.rb',
  '*.ex': '$(capture).html.eex, $(capture).html.heex, $(capture).html.leex',
  '*.dart': '$(capture).freezed.dart, $(capture).g.dart, $(capture).mapper.dart',
  '*.proto': '$(capture).pb.go, $(capture).pb.micro.go',
  '*.sql': '$(capture).tables.sql, $(capture).data.sql',
  '*.md': '$(capture).*',

  // ── Build tools ──
  'Makefile': '*.mk',
  'CMakeLists.txt': '*.cmake, *.cmake.in, .cmake-format.yaml, CMakePresets.json',
  'BUILD.bazel': '*.bzl, *.bazel, *.bazelrc, bazel.rc, .bazelignore, .bazelproject, .bazelversion, MODULE.bazel.lock, WORKSPACE',

  // ── Framework configs ──
  'vite.config.*': '*.env, .babelrc*, .codecov, .cssnanorc*, .env.*, .envrc, .htmlnanorc*, .lighthouserc.*, .mocha*, .postcssrc*, .terserrc*, api-extractor.json, ava.config.*, babel.config.*, capacitor.config.*, content.config.*, contentlayer.config.*, cssnano.config.*, cypress.*, env.d.ts, formkit.config.*, formulate.config.*, histoire.config.*, htmlnanorc.*, i18n.config.*, ionic.config.*, jasmine.*, jest.config.*, jsconfig.*, karma*, lighthouserc.*, panda.config.*, playwright.config.*, postcss.config.*, puppeteer.config.*, react-router.config.*, rspack.config.*, sst.config.*, svgo.config.*, tailwind.config.*, tsconfig.*, tsdoc.*, uno.config.*, unocss.config.*, vitest.config.*, vuetify.config.*, webpack.config.*, windi.config.*',
  'next.config.*': '*.env, .babelrc*, .codecov, .cssnanorc*, .env.*, .envrc, .htmlnanorc*, .lighthouserc.*, .mocha*, .postcssrc*, .terserrc*, api-extractor.json, ava.config.*, babel.config.*, capacitor.config.*, content.config.*, contentlayer.config.*, cssnano.config.*, cypress.*, env.d.ts, formkit.config.*, formulate.config.*, histoire.config.*, htmlnanorc.*, i18n.config.*, ionic.config.*, jasmine.*, jest.config.*, jsconfig.*, karma*, lighthouserc.*, next-env.d.ts, next-i18next.config.*, panda.config.*, playwright.config.*, postcss.config.*, puppeteer.config.*, react-router.config.*, rspack.config.*, sst.config.*, svgo.config.*, tailwind.config.*, tsconfig.*, tsdoc.*, uno.config.*, unocss.config.*, vitest.config.*, vuetify.config.*, webpack.config.*, windi.config.*',
  'nuxt.config.*': '*.env, .babelrc*, .codecov, .cssnanorc*, .env.*, .envrc, .htmlnanorc*, .lighthouserc.*, .mocha*, .nuxtignore, .nuxtrc, .postcssrc*, .terserrc*, api-extractor.json, ava.config.*, babel.config.*, capacitor.config.*, content.config.*, contentlayer.config.*, cssnano.config.*, cypress.*, env.d.ts, formkit.config.*, formulate.config.*, histoire.config.*, htmlnanorc.*, i18n.config.*, ionic.config.*, jasmine.*, jest.config.*, jsconfig.*, karma*, lighthouserc.*, nuxt.schema.*, panda.config.*, playwright.config.*, postcss.config.*, puppeteer.config.*, react-router.config.*, rspack.config.*, sst.config.*, svgo.config.*, tailwind.config.*, tsconfig.*, tsdoc.*, uno.config.*, unocss.config.*, vitest.config.*, vuetify.config.*, webpack.config.*, windi.config.*',
  'svelte.config.*': '*.env, .babelrc*, .codecov, .cssnanorc*, .env.*, .envrc, .htmlnanorc*, .lighthouserc.*, .mocha*, .postcssrc*, .terserrc*, api-extractor.json, ava.config.*, babel.config.*, capacitor.config.*, content.config.*, contentlayer.config.*, cssnano.config.*, cypress.*, env.d.ts, formkit.config.*, formulate.config.*, houdini.config.*, htmlnanorc.*, i18n.config.*, ionic.config.*, jasmine.*, jest.config.*, jsconfig.*, karma*, lighthouserc.*, mdsvex.config.js, panda.config.*, playwright.config.*, postcss.config.*, puppeteer.config.*, react-router.config.*, rspack.config.*, sst.config.*, svgo.config.*, tailwind.config.*, tsconfig.*, tsdoc.*, uno.config.*, unocss.config.*, vite.config.*, vitest.config.*, vuetify.config.*, webpack.config.*, windi.config.*',
  'astro.config.*': '*.env, .babelrc*, .codecov, .cssnanorc*, .env.*, .envrc, .htmlnanorc*, .lighthouserc.*, .mocha*, .postcssrc*, .terserrc*, api-extractor.json, ava.config.*, babel.config.*, capacitor.config.*, content.config.*, contentlayer.config.*, cssnano.config.*, cypress.*, env.d.ts, formkit.config.*, formulate.config.*, histoire.config.*, htmlnanorc.*, i18n.config.*, ionic.config.*, jasmine.*, jest.config.*, jsconfig.*, karma*, lighthouserc.*, panda.config.*, playwright.config.*, postcss.config.*, puppeteer.config.*, react-router.config.*, rspack.config.*, sst.config.*, svgo.config.*, tailwind.config.*, tsconfig.*, tsdoc.*, uno.config.*, unocss.config.*, vitest.config.*, vuetify.config.*, webpack.config.*, windi.config.*',
  'vue.config.*': '*.env, .babelrc*, .codecov, .cssnanorc*, .env.*, .envrc, .htmlnanorc*, .lighthouserc.*, .mocha*, .postcssrc*, .terserrc*, api-extractor.json, ava.config.*, babel.config.*, capacitor.config.*, content.config.*, contentlayer.config.*, cssnano.config.*, cypress.*, env.d.ts, formkit.config.*, formulate.config.*, histoire.config.*, htmlnanorc.*, i18n.config.*, ionic.config.*, jasmine.*, jest.config.*, jsconfig.*, karma*, lighthouserc.*, panda.config.*, playwright.config.*, postcss.config.*, puppeteer.config.*, react-router.config.*, rspack.config.*, sst.config.*, svgo.config.*, tailwind.config.*, tsconfig.*, tsdoc.*, uno.config.*, unocss.config.*, vitest.config.*, vuetify.config.*, webpack.config.*, windi.config.*',
  'remix.config.*': '*.env, .babelrc*, .codecov, .cssnanorc*, .env.*, .envrc, .htmlnanorc*, .lighthouserc.*, .mocha*, .postcssrc*, .terserrc*, api-extractor.json, ava.config.*, babel.config.*, capacitor.config.*, content.config.*, contentlayer.config.*, cssnano.config.*, cypress.*, env.d.ts, formkit.config.*, formulate.config.*, histoire.config.*, htmlnanorc.*, i18n.config.*, ionic.config.*, jasmine.*, jest.config.*, jsconfig.*, karma*, lighthouserc.*, panda.config.*, playwright.config.*, postcss.config.*, puppeteer.config.*, react-router.config.*, remix.*, rspack.config.*, sst.config.*, svgo.config.*, tailwind.config.*, tsconfig.*, tsdoc.*, uno.config.*, unocss.config.*, vitest.config.*, vuetify.config.*, webpack.config.*, windi.config.*',

  // ── SvelteKit routing ──
  '+page.svelte': '+page.server.ts, +page.server.js, +page.ts, +page.js, +page.gql',
  '+layout.svelte': '+layout.ts, +layout.js, +layout.server.ts, +layout.server.js, +layout.gql',
};

// ─── Nesting Logic ────────────────────────────────────────────────

/**
 * Replace $(capture) in a pattern with the base name (no extension) of the parent file.
 * @param {string} pattern
 * @param {string} parentName  e.g. "foo.ts"
 * @returns {string}  e.g. "foo.js"
 */
function resolveCapture(pattern, parentName) {
  const dotIdx = parentName.lastIndexOf('.');
  const baseName = dotIdx > 0 ? parentName.slice(0, dotIdx) : parentName;
  return pattern.replace(/\$\(capture\)/g, baseName);
}

/**
 * Apply nesting rules to a flat file list.
 *
 * @param {Array<{name: string, isDirectory: boolean}>} files  flat file list from API
 * @param {object} rules  NESTING_RULES map
 * @returns {Array}  nested items: { name, isDirectory, children?: [...], _parent?: string }
 */
export function applyNesting(files, rules = NESTING_RULES) {
  // Separate dirs and files
  const dirs = files.filter(f => f.isDirectory);
  const fileItems = files.filter(f => !f.isDirectory);
  const fileNames = fileItems.map(f => f.name);

  // Track which files are claimed as children
  const claimed = new Set();
  const result = [];

  // For each file, check if it matches any parent pattern
  for (const item of fileItems) {
    // Check if this file is already claimed as a child
    if (claimed.has(item.name)) continue;

    // Check if this file matches any parent pattern
    let childPatterns = null;
    for (const [parentPattern, childPatternList] of Object.entries(rules)) {
      if (globMatchAny(item.name, parentPattern)) {
        childPatterns = childPatternList;
        break;
      }
    }

    if (!childPatterns) {
      result.push(item);
      continue;
    }

    // This file is a parent — find its children
    const resolvedPatterns = childPatterns.split(',').map(p => {
      const trimmed = p.trim();
      return resolveCapture(trimmed, item.name);
    });

    const children = [];
    for (const childItem of fileItems) {
      if (childItem.name === item.name) continue;
      if (claimed.has(childItem.name)) continue;

      // Check if child matches any resolved pattern
      for (const pattern of resolvedPatterns) {
        if (globMatchAny(childItem.name, pattern)) {
          children.push(childItem);
          claimed.add(childItem.name);
          break;
        }
      }
    }

    if (children.length > 0) {
      result.push({ ...item, children, _parent: item.name });
    } else {
      result.push(item);
    }
  }

  // Add remaining unclaimed files
  for (const item of fileItems) {
    if (!claimed.has(item.name) && !result.find(r => r.name === item.name)) {
      result.push(item);
    }
  }

  // Dirs always go in
  for (const dir of dirs) {
    if (!result.find(r => r.name === dir.name)) {
      result.push(dir);
    }
  }

  // Sort: dirs first, then files, alphabetically within each group
  result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return result;
}
