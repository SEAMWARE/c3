#
# c3.rb - the Homebrew formula of c³. This repository is its tap (INSTALL.md):
#
#   brew tap seamware/c3 https://github.com/SEAMWARE/c3
#   brew install --HEAD seamware/c3/c3
#
# Built on the Mac from the sources: c3, corMcp (AI Assist's tool server) and the eight
# cor-libs they link, their main.
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
class C3 < Formula
  desc "Coraine Control Center - compile, configure and connect NGSI-LD brokers, with AI Assist"
  homepage "https://github.com/SEAMWARE/c3"
  license "Apache-2.0"
  head "https://github.com/SEAMWARE/c3.git", branch: "main"

  depends_on "openssl@3"

  COR_LIBS = %w[corBase corAlloc corLog corTree corJson corArgs corHttp corRest].freeze
  COR_LIB_BRANCHES = {}.freeze                          # a repo's branch other than main (c3's CI tests with it)

  (COR_LIBS + ["corMcp"]).each do |repo|
    resource repo do
      url "https://github.com/SEAMWARE-cor/#{repo}.git", branch: COR_LIB_BRANCHES.fetch(repo, "main")
    end
  end

  def install
    libs = buildpath/"cor"
    ssl  = Formula["openssl@3"].opt_prefix

    COR_LIBS.each do |lib|
      resource(lib).stage(libs/lib)
      system "make", "-C", libs/lib, "BUILD=release", "COR_HTTP_SERVER=builtin",
             "EXTRA_CFLAGS=-I#{ssl}/include -Wno-nonportable-include-path", "lib#{lib}.a"
    end

    system "make", "COR_LIBS=#{libs}", "C3_CLONES=", "OPENSSL=#{ssl}", "c3"

    resource("corMcp").stage(buildpath/"corMcp")
    system "make", "-C", buildpath/"corMcp", "COR_LIBS=#{libs}", "OPENSSL=#{ssl}"

    bin.install "c3", buildpath/"corMcp/corMcp"
    (share/"c3").install "www"
  end

  def caveats
    <<~EOS
      c3 opens its window in Google Chrome when it is installed, else in your default browser.
      AI Assist runs Claude Code on your own login, with corMcp (installed with c3) as its tool server:
        install Claude Code and log in (https://claude.com/claude-code), then start c3 as  C3_DEV=1 c3
      Its instructions and knowledge: a clone of SEAMWARE-cor/coraine-assistant in ~/git/coraine-assistant
        (or C3_ASSIST_DIR=<the clone>).
    EOS
  end

  test do
    port = free_port
    pid  = spawn bin/"c3", "--port", port.to_s, "--no-browser", "--config", testpath/"c3.json"
    sleep 2
    assert_match "<html", shell_output("curl -s http://127.0.0.1:#{port}/")
    assert_match "corMcp", shell_output("#{bin}/corMcp --broker http://127.0.0.1:1 < /dev/null 2>&1", 0)
  ensure
    Process.kill("TERM", pid) if pid
  end
end
