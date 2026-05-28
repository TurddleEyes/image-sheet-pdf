# Image Sheet PDF

Arrange image files, export each image as a full-page PDF sheet, or stack the ordered images into a single tall image.

## Builds

- Windows: `npm run dist:win`
- Android debug APK: `npm run android:apk`

## GitHub Releases Updates

The app checks GitHub Releases at:

`https://github.com/TurddleEyes/image-sheet-pdf/releases`

Windows installer builds use `electron-updater` and prompt before downloading and installing an update. Android checks for newer releases and prompts the user to open the release page to download the APK.

To publish a Windows release after the GitHub repo exists:

```powershell
$env:GH_TOKEN="your_github_token"
npm run publish:win
```

For Android, attach `android/app/build/outputs/apk/debug/app-debug.apk` or a signed release APK to the same GitHub Release.
