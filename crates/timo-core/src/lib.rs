//! Pure tracking logic: no I/O, no clocks, no OS. Every function here is a
//! port of a named TypeScript function in `legacy/agent` or `packages/core`
//! and is held to it by golden fixtures dumped from the TypeScript itself.
#![forbid(unsafe_code)]
