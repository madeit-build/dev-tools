# Anatomy of a shared package

**Status:** accepted
**Date:** 2026-11-25

## Context

`@madeit-build/log` is the only shared package Made I.T. has. It was built
without a written rule for what a shared package is, so its shape is a set of
precedents nobody decided:

- It lives at `src/log/`, with the TypeScript core in `src/log/src/core`.
- Its contract is data: `src/log/schema/madeit-log-v1.json` and
  `src/log/schema/redaction-cases.json`. The TypeScript core and the Python
  mirror in `src/log/python` are both tested against those files.
- It ships a library and a CLI (`madeit-log`) from one package.
- It reaches consumers through two channels. `publish-log.yml` publishes to
  GitHub Packages on every push to `main` that touches the core. The fleet
  does not use the registry: box.provisioning takes this repo as a flake input
  and builds the package from source, so `main` is also a release channel.
- It has one runtime dependency, `@logtape/logtape`, chosen because it has
  none of its own. hookd enforces that with a test that walks the tree
  (agent-utilities, `docs/adrs/2026-09-10-a-dependency-with-no-dependencies.md`).

A second package is now wanted. The same question, "which project is this work
about", is answered three different ways inside hookd alone (git common dir,
folder name, path-segment walk), and a fourth copy is a hardcoded string in its
loggers. On 2026-11-24 one of those answers filed a card as "captured while
working in gufo-v0.35.0 on branch HEAD": a scratch clone of someone else's
repo, on a detached tag. The nightly caretaker then researched the wrong repo.

The first instinct was a package named for that one function. That is the
question this ADR exists to settle before it is settled by accident: what earns
a package, and what must every package have.

## Decision

### 1. A package is a domain, not a function

A shared package is named for a domain noun and states its scope in one
sentence at the top of its README. `log` answers "what happened". The next
one, `workspace`, answers "where is this work happening".

A new capability goes into an existing package as a subpath export
(`@madeit-build/workspace/project`) when it fits that sentence. It earns its
own package only when one of these is true:

- it needs a runtime dependency the existing package does not have;
- it has a different set of consumers, so its releases would bump people who
  do not use it.

An export that does not fit the scope sentence needs a new ADR, not a wider
sentence.

### 2. Dependencies are welcome, named, and the consumer sets its own limit

A shared package reaches for a well-supported open-source package before
writing the same thing here. Each runtime dependency is named in the README
with the reason it was chosen.

How deep a tree a consumer will accept is the consumer's rule, not the
package's. hookd sits on the hot path of every tool call and accepts only
trees that end in dependency-free leaves; its own test enforces that. Most
consumers have no such limit.

So each README states one fact: whether the package is **shallow** (it passes
hookd's walk) or **open** (it does not). A package that a hot-path consumer
already uses stays shallow. A capability that needs a deeper tree goes in its
own package under decision 1, so it never changes what an existing consumer
installs.

### 3. The contract is data, and every implementation is tested against it

Each package has a `schema/` directory holding a JSON Schema for what it emits
and a cases file of inputs and expected outputs. The schema filename carries
the contract version (`-v1`). A breaking change is a new schema file, not an
edit.

A port to another language is written when a consumer in that language exists,
never ahead of one, and it is not done until it passes the same cases.

### 4. Library first, with a CLI that explains itself

- ESM only, an `exports` map with one entry per subpath, `sideEffects: false`,
  shipped types, `engines.node >= 22`.
- A CLI in the same package when a non-TypeScript caller exists or when a
  person needs to ask the package why it answered the way it did. The CLI
  prints the same structure the library returns, as JSON.
- A library returns its evidence; it does not log. A function that picks
  between candidates returns every candidate it considered and why each won or
  lost. The caller decides what to log. This keeps packages free of a logging
  dependency and still makes "why did that not happen" answerable without
  adding code.

### 5. Two release channels, and both are real

Every package is published to GitHub Packages and is buildable from this
repo's source at any commit on `main`. A change is not releasable unless the
package's tests can run in a consumer's build, because the fleet's weekly
flake bump moves `main` with nobody reading the diff.

### 6. Every README answers security in three parts

What the package reads, what it executes, and what it must never emit. For a
package that handles identity: who the caller is, what proves it, and what
they may do, as three separate answers.

## Consequences

### Gained

- The next package starts from a checklist instead of from `src/log` and a
  guess about which parts were deliberate.
- One publish and one version bump per domain, not per function. The
  caretaker pins its `node_modules` by content hash, so each new package it
  takes is a deliberate hash refresh.
- A consumer can tell from one line of a README whether it may take a
  package, and a package never grows a tree under a consumer that cannot
  accept one.
- Ports cannot drift silently: the cases file fails them.

### Paid

- Wrapping a library with a deep tree means a second package and a second
  pin, even when the capability belongs to an existing domain.
- "Shallow" is only as true as the last run of the consumer's test. Nothing in
  this repo fails when a shallow package's dependency grows a tree.
- "Return evidence, do not log" pushes logging work onto every caller.
- Domain packages can become junk drawers. The scope sentence is the only
  guard, and it holds only if reviewers enforce it.
- `@madeit-build/log` does not fully match this ADR today (see below), so the
  rule is ahead of the only example.

## Alternatives considered

**One package per function** (`@madeit-build/project`). Smallest unit, clearest
name. Rejected: each package is its own publish, its own version, and its own
pin in every consumer. Smaller packages do not help tree shaking, which works
per module inside a package; subpath exports give the same result.

**One `@madeit-build/utils` package.** One pin for everything. Rejected: it
couples unrelated release cadences and drags every dependency into every
consumer. The resolver needs nothing but `git`; it should not pull logtape
into a consumer that does not log.

**Put the resolver in `@madeit-build/log`.** No new package at all. Rejected:
it fails decision 1's scope test, and log would then be required by anything
that only wants to know where it is.

**A CLI only, every caller shells out.** One implementation in any language.
Rejected on the log package's own measurement: about 14 ms per process start
(`src/log/README.md`, "Measured costs"). hookd runs on every tool call.

**Keep copying.** No coordination cost. Rejected: this is the status quo that
produced three answers and the 2026-11-24 card.

## Follow-up work

- `@madeit-build/log` has no `sideEffects` field and one `exports` entry.
  Bring it in line or record why not.
- `publish-log.yml` is specific to one package and derives the version from
  the registry's patch number, ignoring `package.json`. Decide whether a
  second package reuses that workflow, and who owns major and minor.
- hookd depends on `@madeit-build/log` at `^0.0.1`, which npm resolves to
  exactly 0.0.1, while the manifest in this repo says 0.1.0. Whether hookd is
  behind on purpose was not checked.
- box.provisioning builds the log package with a pinned pnpm dependency hash.
  Whether adding a workspace package changes that hash was not checked, and it
  decides whether a new package can break the weekly flake bump.
