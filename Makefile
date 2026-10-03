.PHONY: help deploy-q2 deploy-q2-sjekk

# make leser miljøvariabler som make-variabler. En REF fra miljøet kan være en
# eksport fra annet arbeid eller et bevisst valg; begge gjetninger kan deploye
# feil commit, så den avvises og må oppgis på kommandolinjen.
ifneq ($(filter environment%,$(origin REF)),)
$(error REF=$(REF) kommer fra miljøet. Oppgi den på kommandolinjen (make deploy-q2 REF=…), eller kjør `unset REF` for tuppen av muninn main)
endif

help:
	@echo "make deploy-q2 [REF=<tag|sha>]        deployer muninn til q2; standard er tuppen av muninn main"
	@echo "make deploy-q2-sjekk [REF=<tag|sha>]  bare forhåndssjekkene, starter ingen workflow"

deploy-q2:
	@scripts/deploy-q2.sh $(REF)

deploy-q2-sjekk:
	@DRY_RUN=1 scripts/deploy-q2.sh $(REF)
