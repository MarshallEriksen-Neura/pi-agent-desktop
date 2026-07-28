@echo off
rem Thin launcher: forwards all arguments to the Node wrapper script, which
rem initialises the VC environment, strips the `-Brepro` flag injected by the
rem `cc` crate on MSVC targets, and delegates to the real cl.exe.
rem See cc-no-brepro.js for details.
node "%~dp0cc-no-brepro.js" %*
