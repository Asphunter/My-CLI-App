@echo off
rem Egy kattintas: friss frontend- es Rust-build, majd inditas. A debug app
rem bezarasa utan automatikusan ujraepit es ujraindul; a CMD bezarasa allitja le.
rem
rem Miert nem eleg a min.exe-re mutato parancsikon: a nyers `cargo build`
rem kihagyja a tauri CLI-t, ezert a tauri.conf.json `beforeBuildCommand`-ja sem
rem fut le, es a binarisba a regi `dist/` fordul bele. Itt a ket lepes egymas
rem utan all, kifejezetten.
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem A build sajat mappaba megy, es csak a kesz exe kerul a parancsikon helyere.
rem A LOCALAPPDATA alatt (pl. `%LOCALAPPDATA%\min\...`) ezen a gepen a cargo
rem archivum-lepese rendszeresen fajlzarba utkozik ("failed to remove temporary
rem directory", os error 32), ezert a Temp alatt epitunk - ott nincs zar.
rem Cserebe a Windows Temp-takaritasa neha kitorolhet fajlokat a cache-bol;
rem ezt lentebb automatikus cache-torles + teljes ujraepites kezeli.
set "BUILD_DIR=%LOCALAPPDATA%\Temp\min-cargo-target"
set "SHORTCUT_EXE=%LOCALAPPDATA%\min\cargo-target\debug\min.exe"
set "CARGO_TARGET_DIR=%BUILD_DIR%"

rem A futo peldany fogja a min.exe-t; a masolas ilyenkor nem sikerulne.
tasklist /FI "IMAGENAME eq min.exe" | find /I "min.exe" >nul && (
  echo A min mar fut. Zard be, majd inditsd ujra ezt a parancsikont.
  echo.
  pause
  exit /b 1
)

:rebuild
echo [1/3] Frontend build ^(tsc + vite^)...
call npm.cmd run build || goto :failed

echo.
echo [2/3] Rust build ^(custom-protocol^)...
call cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol && goto :install

rem A build elhasalt. Ha kornyezeti hiba (a Temp-takaritas kitorolt fajlokat a
rem cache-bol, vagy fajlzar), a cache torlese + teljes ujraepites megoldja;
rem kodhibanal viszont ertelmetlen lenne a cache-t eldobni. A megkulonboztetes:
rem gyors ujrafuttatas naploba, es a naplo jellegzetes hibaszovegei dontenek.
echo.
echo A Rust build elhasalt - a hiba okanak vizsgalata...
set "BUILD_LOG=%TEMP%\min-build-probe.log"
call cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol > "%BUILD_LOG%" 2>&1
if not errorlevel 1 goto :install
findstr /C:"couldn't read" /C:"failed to remove temporary directory" "%BUILD_LOG%" >nul || goto :failed
echo Serult build cache - torles es teljes ujraepites ^(tobb perc is lehet^)...
rmdir /s /q "%BUILD_DIR%" 2>nul
call cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol || goto :failed

:install
echo.
echo [3/3] Telepites a parancsikon helyere...
if not exist "%LOCALAPPDATA%\min\cargo-target\debug\" mkdir "%LOCALAPPDATA%\min\cargo-target\debug"
copy /y "%BUILD_DIR%\debug\min.exe" "%SHORTCUT_EXE%" >nul || goto :failed

echo.
echo Indul a min... ^(az app bezarasa utan automatikusan ujraindul^)
echo A ciklus leallitasahoz zard be ezt a CMD ablakot.
"%SHORTCUT_EXE%"
echo.
echo A min bezarult. Ujraepites es ujrainditas...
timeout /t 1 /nobreak >nul
goto :rebuild

:failed
echo.
echo A build elhasalt - az app NEM indult el, a korabbi buildet nem irtam felul.
echo A hibauzenet feljebb olvashato.
echo.
pause
exit /b 1
