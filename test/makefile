# TODO: this makefile is currently OS X specific, using the `open` command. Refactor to be os agnostic
all: generate-pandoc generate-writedown-pdf generate-writedown-tex open-all-pdfs

test-pandoc: generate-pandoc open-pdf
test-writedown: generate-writedown open-pdf


create-target-dir:
	mkdir -p pub

clean:
	rm -r pub


open-pdf:
	open pub/${document_name}.pdf

open-all-pdfs:
	open pub/*.pdf	

generate-pandoc: create-target-dir
	$(info ****** Testing with pandoc)
	$(eval document_name=test-pandoc)
	pandoc --smart --standalone -f markdown --listings --template=../template.tex -t latex test-pandoc.md -o pub/test-pandoc.pdf

generate-writedown-pdf: create-target-dir
	$(info ****** Testing with writedown)
	$(eval document_name=Test_Document_vDRAFT)
	./writedown/render pdf

generate-writedown-tex: create-target-dir
	$(info ****** Testing with writedown)
	$(eval document_name=Test_Document_vDRAFT)
	./writedown/render latex


