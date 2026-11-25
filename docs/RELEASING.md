# Releasing

How to publish a new version.

1. **Test.** Run `npm test`. All suites should say `All checks passed.`
2. **Smoke test by hand.** Run `npm start` and check the buddy, a bubble, a Pomodoro, and a task reminder.
3. **Version.** Update `"version"` in `package.json` and add a section to `CHANGELOG.md`.
4. **Build the installer.**
   ```powershell
   npm install
   npm run dist
   ```
   The installer is created in `dist/` and is named like `Desktop Buddy Setup 0.1.0.exe`.
   If the build stops with a "symbolic link" privilege error, turn on *Developer Mode* in
   Windows settings (or run the terminal as administrator) and run it again.
5. **Try the installer.** Install it, check the tray icon and *Start with Windows*, then uninstall.
6. **Commit and tag.**
   ```powershell
   git add .
   git commit -m "Release 0.1.0"
   git tag v0.1.0
   git push
   git push --tags
   ```
7. **Publish on GitHub.** Open *Releases*, then *Draft a new release*, pick the tag, paste the
   changelog section, attach the `.exe`, tick *Set as a pre-release* while the app is a preview,
   and publish.

## About the Windows warning
The installer is not code-signed, so Windows SmartScreen shows "Windows protected your PC" the first
time. Choose *More info*, then *Run anyway*. Signing needs a paid certificate and is on the backlog.
