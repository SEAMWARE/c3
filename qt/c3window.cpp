//
// FILE            c3window.cpp
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// c3-window - c³'s own window: the pages of a c3 in a Qt WebEngine view (Chromium, as Chrome's --app window was)
//
//   c3-window <url> [--stdin]
//
// The window is the program's, not a browser's, so it has what a page cannot ask a browser for:
// - a minimum width: the header's top line (header.js), the page tells it - the window is never made narrower
// - leaving full-screen, the width the header's tabs fit beside its top line, the screen's at most
// - F11 full-screen; out of full-screen, minimise and close from the page's own buttons (window.js), in full-screen
// - its Wayland app id com.seamware.c3 (the desktop entry's name and StartupWMClass): the dock's c³ icon is this
//   window's - shown running, a click on it shows the window again (minimised: not a c³ started again)
//
// The page talks to the window over a QWebChannel: the object c3window, ready in window.c3windowReady (a
// Promise, made by a script put into every page of c3's origin) - widths(topCss, oneCss), minimize(),
// close(), fullScreen(), normal() (out of full-screen, as F11), the property full and its signal fullChanged.
//
// --stdin: started by a c3 that keeps the other end of the pipe (browser.c, window.c). A line "raise [token]"
// brings the window to the front - the token, Wayland's xdg-activation, the one of the click that asked (a c3
// started again, the dock's button). The pipe closed (that c3 gone): the window closes.
//
// Links: c3's own pages open in the window; any other page in the desktop's browser. A popup the page opens
// with features (the login window, connect.js) opens as a window of its own, beside this one.
//
// Keys: F11 full-screen, F5 / Ctrl+R reload, Ctrl+Shift+R reload without the cache, F12 / Ctrl+Shift+I the
// developer tools.
//
#include <unistd.h>                              // read

#include <QApplication>
#include <QDesktopServices>
#include <QDir>
#include <QFile>
#include <QIcon>
#include <QKeySequence>
#include <QMainWindow>
#include <QScreen>
#include <QShortcut>
#include <QSocketNotifier>
#include <QStandardPaths>
#include <QTimer>
#include <QUrl>
#include <QWebChannel>
#include <QWebEngineDownloadRequest>
#include <QWebEnginePage>
#include <QWebEngineProfile>
#include <QWebEngineScript>
#include <QWebEngineScriptCollection>
#include <QWebEngineSettings>
#include <QWebEngineView>



// -----------------------------------------------------------------------------
//
// ExternalPage - a page asked for by a link to a new tab (target=_blank, window.open without features): its
// URL opened in the desktop's browser, the page then gone
//
class ExternalPage : public QWebEnginePage
{
public:
  explicit ExternalPage(QWebEngineProfile* profile, QObject* parent) : QWebEnginePage(profile, parent) {}

protected:
  bool acceptNavigationRequest(const QUrl& url, NavigationType, bool) override
  {
    if (url.scheme() == "about")
      return true;

    QDesktopServices::openUrl(url);
    deleteLater();
    return false;
  }
};



// -----------------------------------------------------------------------------
//
// popupOpen - a window of its own for a popup the page opened with features (window.open(url, name, "popup,...")):
// the login window - it goes wherever the login takes it, and closes itself
//
static QWebEnginePage* popupOpen(QWebEngineProfile* profile)
{
  QWebEngineView* viewP = new QWebEngineView();
  QWebEnginePage* pageP = new QWebEnginePage(profile, viewP);

  viewP->setPage(pageP);
  viewP->setAttribute(Qt::WA_DeleteOnClose);
  viewP->resize(520, 720);

  QObject::connect(pageP, &QWebEnginePage::windowCloseRequested, viewP, &QWidget::close);
  QObject::connect(pageP, &QWebEnginePage::geometryChangeRequested, viewP, [viewP](const QRect& r) { if (r.width() > 0 && r.height() > 0) viewP->resize(r.size()); });
  QObject::connect(pageP, &QWebEnginePage::titleChanged, viewP, &QWidget::setWindowTitle);

  viewP->show();
  return pageP;
}



// -----------------------------------------------------------------------------
//
// AppPage - c3's page: c3's own origin stays in the window, any other in the desktop's browser
//
class AppPage : public QWebEnginePage
{
public:
  AppPage(QWebEngineProfile* profile, const QUrl& origin, QObject* parent) : QWebEnginePage(profile, parent), origin(origin) {}

protected:
  bool acceptNavigationRequest(const QUrl& url, NavigationType type, bool isMainFrame) override
  {
    if (isMainFrame && ((url.scheme() == "http") || (url.scheme() == "https")) &&
        ((url.host() != origin.host()) || (url.port() != origin.port())))
    {
      QDesktopServices::openUrl(url);
      return false;
    }

    return QWebEnginePage::acceptNavigationRequest(url, type, isMainFrame);
  }

  QWebEnginePage* createWindow(WebWindowType type) override
  {
    if (type == WebDialog)
      return popupOpen(profile());

    return new ExternalPage(profile(), this);
  }

private:
  QUrl origin;
};



// -----------------------------------------------------------------------------
//
// AppWindow - the window: its minimum width, and its width out of full-screen
//
class AppWindow : public QMainWindow
{
  Q_OBJECT

public:
  QWebEngineView* viewP = nullptr;
  int             topCss = 0;                    // the header's top line, CSS pixels (header.js)
  int             oneCss = 0;                    // the top line and the tabs on one line

  //
  // widthsSet - the page's widths: the window's minimum the top line's, in the screen's units (times the zoom)
  //
  void widthsSet(int top, int one)
  {
    topCss = top;
    oneCss = one;

    int least = scaled(topCss);
    int most  = screenWidth();

    setMinimumWidth((most > 0) ? std::min(least, most) : least);
  }

signals:
  void fullChanged(bool full);

protected:
  //
  // changeEvent - full-screen or not: the page told; out of full-screen, made one wide (the screen's at most)
  //
  void changeEvent(QEvent* eventP) override
  {
    QMainWindow::changeEvent(eventP);

    if (eventP->type() != QEvent::WindowStateChange)
      return;

    bool full = isFullScreen();

    if (full != wasFull)
    {
      wasFull = full;
      emit fullChanged(full);

      if (!full && !isMinimized() && !isMaximized() && (oneCss > 0))
      {
        QTimer::singleShot(100, this, [this]()
        {
          if (isFullScreen() || isMaximized() || isMinimized())
            return;

          int want = std::max(scaled(oneCss), scaled(topCss));
          int most = screenWidth();

          resize((most > 0) ? std::min(want, most) : want, height());
        });
      }
    }
  }

  void closeEvent(QCloseEvent* eventP) override
  {
    QMainWindow::closeEvent(eventP);
    qApp->quit();                                // the popups and the developer tools go with it
  }

private:
  bool wasFull = false;

  int scaled(int css) const { return (int) (css * ((viewP != nullptr) ? viewP->zoomFactor() : 1.0) + 0.999); }

  int screenWidth() const
  {
    QScreen* screenP = screen();
    return (screenP != nullptr) ? screenP->availableGeometry().width() : 0;
  }
};



// -----------------------------------------------------------------------------
//
// Bridge - what the page may ask of the window (QWebChannel, the object c3window)
//
class Bridge : public QObject
{
  Q_OBJECT
  Q_PROPERTY(bool full READ full NOTIFY fullChanged)

public:
  explicit Bridge(AppWindow* winP) : QObject(winP), winP(winP)
  {
    connect(winP, &AppWindow::fullChanged, this, &Bridge::fullChanged);
  }

  bool full() const { return winP->isFullScreen(); }

  Q_INVOKABLE void widths(int top, int one) { if ((top > 0) && (top < 20000) && (one > 0) && (one < 40000)) winP->widthsSet(top, one); }
  Q_INVOKABLE void minimize()               { winP->showMinimized(); }
  Q_INVOKABLE void close()                  { winP->close(); }
  Q_INVOKABLE void fullScreen()             { winP->showFullScreen(); }
  Q_INVOKABLE void normal()                 { winP->showNormal(); }

signals:
  void fullChanged(bool full);

private:
  AppWindow* winP;
};



// -----------------------------------------------------------------------------
//
// stateDir - $XDG_STATE_HOME/c3/qt, else ~/.local/state/c3/qt: the profile's storage (localStorage, cookies)
//
static QString stateDir(void)
{
  QString state = qEnvironmentVariable("XDG_STATE_HOME");

  if (!state.startsWith('/'))
    state = QDir::homePath() + "/.local/state";

  return state + "/c3/qt";
}



// -----------------------------------------------------------------------------
//
// channelScript - qwebchannel.js and the page's handle on the window: window.c3windowReady
//
static QWebEngineScript channelScript(void)
{
  QFile            lib(":/qtwebchannel/qwebchannel.js");
  QString          source;
  QWebEngineScript script;

  if (lib.open(QIODevice::ReadOnly))
    source = QString::fromUtf8(lib.readAll());

  source += "\nwindow.c3windowReady = new Promise((ok) => new QWebChannel(qt.webChannelTransport, (ch) => ok(ch.objects.c3window)));\n";

  script.setName("c3window");
  script.setSourceCode(source);
  script.setInjectionPoint(QWebEngineScript::DocumentCreation);
  script.setWorldId(QWebEngineScript::MainWorld);
  script.setRunsOnSubFrames(false);

  return script;
}



// -----------------------------------------------------------------------------
//
// shortcut -
//
template <typename F>
static void shortcut(QWidget* winP, const QKeySequence& keys, F what)
{
  QShortcut* sP = new QShortcut(keys, winP);

  sP->setContext(Qt::WindowShortcut);
  QObject::connect(sP, &QShortcut::activated, winP, what);
}



// -----------------------------------------------------------------------------
//
// main -
//
int main(int argC, char* argV[])
{
  QApplication app(argC, argV);

  app.setApplicationName("c3");
  app.setDesktopFileName("com.seamware.c3");     // the desktop's entry: its icon, its name in the dock
  app.setWindowIcon(QIcon::fromTheme("com.seamware.c3"));
  app.setQuitOnLastWindowClosed(false);          // the main window's close quits (closeEvent)

  QStringList args  = app.arguments();
  bool        piped = args.contains("--stdin");
  QUrl        url;

  for (int ix = 1; ix < args.size(); ix++)
  {
    if (!args[ix].startsWith("--"))
      url = QUrl(args[ix]);
  }

  if (!url.isValid() || ((url.scheme() != "http") && (url.scheme() != "https")))
  {
    fprintf(stderr, "Usage: c3-window <url of c3's pages> [--stdin]\n");
    return 1;
  }

  QWebEngineProfile* profileP = new QWebEngineProfile("c3", &app);

  profileP->setPersistentStoragePath(stateDir());
  profileP->setCachePath(stateDir() + "/cache");
  profileP->setPersistentCookiesPolicy(QWebEngineProfile::ForcePersistentCookies);
  profileP->scripts()->insert(channelScript());

  QObject::connect(profileP, &QWebEngineProfile::downloadRequested, [](QWebEngineDownloadRequest* dP) { dP->accept(); });

  AppWindow*      winP  = new AppWindow();
  QWebEngineView* viewP = new QWebEngineView(winP);
  AppPage*        pageP = new AppPage(profileP, url, viewP);
  QWebChannel*    chanP = new QWebChannel(pageP);
  Bridge*         brP   = new Bridge(winP);

  chanP->registerObject("c3window", brP);
  pageP->setWebChannel(chanP);
  viewP->setPage(pageP);
  winP->viewP = viewP;
  winP->setCentralWidget(viewP);
  winP->setWindowTitle("c³ Control Center");
  QObject::connect(pageP, &QWebEnginePage::titleChanged, winP, &QWidget::setWindowTitle);

  //
  // The developer tools, a window of their own
  //
  QWebEngineView* toolsP = nullptr;
  auto tools = [&]()
  {
    if (toolsP == nullptr)
    {
      toolsP = new QWebEngineView();
      toolsP->setPage(new QWebEnginePage(profileP, toolsP));
      toolsP->resize(1100, 800);
      toolsP->setWindowTitle("c³ - developer tools");
      pageP->setDevToolsPage(toolsP->page());
    }
    toolsP->show();
    toolsP->raise();
  };

  shortcut(winP, QKeySequence(Qt::Key_F11),                       [winP]() { if (winP->isFullScreen()) winP->showNormal(); else winP->showFullScreen(); });
  shortcut(winP, QKeySequence(Qt::Key_F5),                        [pageP]() { pageP->triggerAction(QWebEnginePage::Reload); });
  shortcut(winP, QKeySequence(Qt::CTRL | Qt::Key_R),              [pageP]() { pageP->triggerAction(QWebEnginePage::Reload); });
  shortcut(winP, QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_R),  [pageP]() { pageP->triggerAction(QWebEnginePage::ReloadAndBypassCache); });
  shortcut(winP, QKeySequence(Qt::Key_F12),                       tools);
  shortcut(winP, QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_I),  tools);

  //
  // The pipe from c3: "raise [token]" lines; closed, the window goes
  //
  if (piped)
  {
    QSocketNotifier* inP  = new QSocketNotifier(0, QSocketNotifier::Read, &app);
    QByteArray*      bufP = new QByteArray();

    QObject::connect(inP, &QSocketNotifier::activated, [inP, bufP, winP]()
    {
      char    chunk[1024];
      ssize_t n = read(0, chunk, sizeof(chunk));

      if (n <= 0)
      {
        inP->setEnabled(false);
        qApp->quit();
        return;
      }

      bufP->append(chunk, n);

      for (int nl = bufP->indexOf('\n'); nl != -1; nl = bufP->indexOf('\n'))
      {
        QByteArray line = bufP->left(nl).trimmed();

        bufP->remove(0, nl + 1);

        if (line == "raise" || line.startsWith("raise "))
        {
          QByteArray token = line.mid(6).trimmed();

          if (!token.isEmpty())
            qputenv("XDG_ACTIVATION_TOKEN", token);  // Qt's Wayland activation takes it from there

          winP->setWindowState(winP->windowState() & ~Qt::WindowMinimized);
          winP->show();
          winP->raise();
          winP->activateWindow();
        }
      }
    });
  }

  winP->resize(1440, 900);
  viewP->load(url);
  winP->showFullScreen();

  return app.exec();
}

#include "c3window.moc"
