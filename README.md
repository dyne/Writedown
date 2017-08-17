                █               ▗▖
                ▀   ▐▌          ▐▌
    █   █ █▟█▌ ██  ▐███  ▟█▙  ▟█▟▌ ▟█▙ █   █▐▙██▖
    ▜ █ ▛ █▘    █   ▐▌  ▐▙▄▟▌▐▛ ▜▌▐▛ ▜▌▜ █ ▛▐▛ ▐▌
    ▐▙█▟▌ █     █   ▐▌  ▐▛▀▀▘▐▌ ▐▌▐▌ ▐▌▐▙█▟▌▐▌ ▐▌
    ▝█ █▘ █   ▗▄█▄▖ ▐▙▄ ▝█▄▄▌▝█▄█▌▝█▄█▘▝█ █▘▐▌ ▐▌
     ▀ ▀  ▀   ▝▀▀▀▘  ▀▀  ▝▀▀  ▝▀▝▘ ▝▀▘  ▀ ▀ ▝▘ ▝▘
            A slick and static academic publisher

# INTRODUCTION

Writedown is a set of shell scripts to generate books and articles fit
for academic review and publishing. It can be operated on any device
running ZShell, chapters can be written in Markdown syntax and it uses
Latex rendering via Pandoc to produce DOCX, Latex or PDF documents.
It sports automatic generation of the table of contents and the
bibliographic section built out of a bibtex file and simple references
across the text.

[![software by Dyne.org](https://www.dyne.org/wp-content/uploads/2015/12/software_by_dyne.png)](http://www.dyne.org)

Writedown is designed
after [WebNomad](http://www.dyne.org/software/webnomad) and it is
operated in a similar fashion, while both programs are compatible and
can coexist on the same reposiroty, to generate both articles and
webpages from the same text.

Writedown is at an early stage of development. The author's main
motivation to create this software has been that of writing a
Ph.D. thesis using Emacs, yet it may be used with different editors
and for different purposes.

## REQUIREMENTS

Writedown requires the installation of the Zsh shell, present by
default or easily installable in most operating systems. In addition
to that also a recent version of Pandoc is required, preferably
version 1.17 or any later version, providing the "citeproc" extension
to handle bibliographic citations.

If installed from its Git repository, then its necessary also to
download the [zuper](https://github.com/dyne/zuper) submodule using
the command:

    git sudmodule update --init

For integration with the blibliography manager Zotero, one should
install the [zotxt](https://gitlab.com/egh/zotxt) extension by downloading it from:
https://addons.mozilla.org/firefox/downloads/latest/zotxt/addon-454106-latest.xpi

Then if using Emacs to edit markdown files is possible to install
the [zotxt-emacs](https://github.com/egh/zotxt-emacs) package from the
default MELPA repositories and activate the `zotxt-easykey` mode to run queries
using the `C-c " k` key combo.


## BASIC USAGE

First create a directory for your article, then place the writedown
directory inside it, i.e. the one downloaded from the source archive
or git repo.

From a terminal, cd inside your new article's directory and run:

    ./writedown/init 

the skeleton of your new webpage is created inside the directory:

    config.zsh -> contains title and general configurations
    views/*.md -> each file is a chapter written
	views/index.txt -> the order of chapters, one per line
	views/options.sty -> custom options for latex/pdf render
    views/abstract.txt -> contains the abstract of the article
	views/references.bib -> contains bibtex entries


## RENDER FINAL RESULT

To render final results, run `./writedown/render` and your article
will be in the `pub/` directory.

When used, the first argument of the render command can be one of the
three supported formats:

	./writedown/render pdf
	./writedown/render docx
	./writedown/render latex

For more custom rendering solutions, see config.zsh and the commented
settings `WRITEDOWN_OUTPUT_FORMAT` and `WRITEDOWN_OUTPUT_EXTENSION`
which can be configured to match the output format for pandoc and the
extension of the resulting file.

In addition to the first argument indicating the extension, a second
argument may be present to indicate the rendering of a single section
(i.e. markdown source file) instead of the whole book index:

	./writedown/render pdf chapter_one

The above command will render the file `chapter_one.md` found in the
`views/` directory.

If error occur in the rendering it is possible to activate a more
verbose output by entering the `DEBUG` mode, this is simply done
prefixing the command as follows:

    DEBUG=1 ./writedown/render pdf

Debugging output will include all latex rendering messages previous to
the pdf rendering and any other information related to the command.

## DEVELOPERS

Bleeding edge is on GitHub. See https://github.com/dyne/writedown

Pull requests and translations of this documentation are welcome.

Come on IRC channel #dyne via https://irc.dyne.org to get in touch.


## DONATE

Money donations are very welcome and well needed

https://www.dyne.org/donate


# LICENSE

Writedown is Copyright (C) 2016-2017 by the Dyne.org Foundation

Writedown is designed, written and maintained by Denis Roio <jaromil@dyne.org>

    This program is free software: you can redistribute it and/or
    modify it under the terms of the GNU Affero General Public License
    as published by the Free Software Foundation, either version 3 of
    the License, or (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
    Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public
    License along with this program.  If not, see
    http://www.gnu.org/licenses
