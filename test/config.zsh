DEBUG=0
LOG="./writedown.log"

WRITEDOWN_VERSION="DRAFT"

# Added by Writedown on Mon Apr 10 12:10:58 CEST 2017
WRITEDOWN_TITLE="Test Document v${WRITEDOWN_VERSION}"
WRITEDOWN_AUTHOR="[Johan Sebastien Bach, Ludvig Van Beethoven, Wolfgang Amadeus Mozart, Igor Stravinsky]"
WRITEDOWN_AFFILIATION="University of Great Composers"
#WRITEDOWN_DATE="Monday 10 April 2017"
WRITEDOWN_TAGS="[music, symphony, composers]"

# number for each section
WRITEDOWN_NRSEC=no
# table of contents
WRITEDOWN_TOC=yes
#WRITEDOWN_TOC_DEPTH=3
# bibliographic citation style (see writedown/citstyle)
WRITEDOWN_CITSTYLE=harvard-kings-college-london
# font size
WRITEDOWN_FONTSIZE=14pt
# bibtex file for bibliographic sources
WRITEDOWN_BIB=views/references.bib

# different formats as supported by pandoc.
# to activate uncomment and fill, then use dash (-) as first argument
# i.e: ./writedown/render -
#WRITEDOWN_OUTPUT_FORMAT=pdf
# WRITEDOWN_OUTPUT_EXTENSION=epub

# default pandoc base command
#WRITEDOWN_PANDOC="pandoc --smart --standalone -f $input_format "
# WRITEDOWN_PANDOC="pandoc --template=simple-template.tex decode-whitepaper.md  --latex-engine=xelatex -o publish/decode-whitepaper-vDRAFT.pdf"

# --variable mainfont=\"Helvetica Neue\" --variable sansfont=Arial --variable monofont=\"Courier New\" --variable fontsize=12pt --variable version=DRAFT-0.1
# --variable geometry=a4paper
