all: generate-pdf open-pdf

create-target-dir:
	mkdir -p pub

clean:
	rm -r pub

generate-pdf: create-target-dir
	./writedown/render pdf

open-pdf:
	open pub/DECODE_Whitepaper_vDRAFT.pdf


