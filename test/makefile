all: generate-pdf open-pdf

create-target-dir:
	mkdir -p pub

clean:
	rm -r pub

generate-pdf: create-target-dir
	document_name="Test_Document_vDRAFT"
	./writedown/render pdf

open-pdf:
	open pub/${document_name}.pdf

generate-pandoc-direct:
	$(eval document_name="test-metadata")
	pandoc --smart --standalone -f markdown --verbose --template ../template.tex -H views/options.sty -t latex test-pandoc-meta.md -o pub/test-metadata.pdf


test-pandoc: generate-pandoc-direct open-pdf
