DESTDIR?=
PREFIX?=/usr/local/writedown
CONFDIR?=/etc/writedown

all:
	@echo
	@echo "Writedown is ready to run, copy this directory inside a project"
	@echo "review config.zsh and run writedown/render. Refer to the README"
	@echo "for more information. Run 'sudo make install' to have it installed."
	@echo

install:
	@install -d ${DESTDIR}${PREFIX}
	@install -p -m 755 init   ${DESTDIR}${PREFIX}/init
	@install -p -m 755 render ${DESTDIR}${PREFIX}/render
	@install -d ${DESTDIR}${PREFIX}/zuper
	@install -p -m 644 zuper/zuper      ${DESTDIR}${PREFIX}/zuper/zuper
	@install -p -m 644 zuper/zuper.init ${DESTDIR}${PREFIX}/zuper/zuper.init
	@install -d ${DESTDIR}${CONFDIR}
	@install -p -m 644 template.tex ${DESTDIR}${CONFDIR}/template.tex
	@install -p -m 644 config.zsh   ${DESTDIR}${CONFDIR}/config.zsh
	@install -p -m 755 writedown ${DESTDIR}/usr/local/bin/writedown
	@install -p -m 755 writedown ${DESTDIR}/usr/local/bin/writedown-pdf
	@install -p -m 755 writedown ${DESTDIR}/usr/local/bin/writedown-docx
	@install -p -m 755 writedown ${DESTDIR}/usr/local/bin/writedown-latex
	@echo "Writedown correctly installed in ${DESTDIR}${PREFIX}"
	@echo "Default configuration copied in  ${DESTDIR}${CONFDIR}"
