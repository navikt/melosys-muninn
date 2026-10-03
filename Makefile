.PHONY: help deploy-q2 deploy-q2-sjekk

# Målene tar ingen ref. En bestemt ref gis som argument til skriptet.
#
# En REF med innhold på kommandolinjen, i miljøet eller fra `make -e` stopper
# make før noe kjører. `$(value …)` gjør at verdien ikke ekspanderes her. Make
# 3.81 har to unntak som ikke kan stoppes fra Makefile: en REF i MAKEFLAGS
# ekspanderes allerede når make leser den (og stopper bare om resultatet har
# innhold), og `override REF=…` på kommandolinjen ignoreres og gir tuppen av main.
ifneq ($(value REF),)
$(error make-målene deployer alltid tuppen av muninn main og tar ingen REF. For en bestemt ref: scripts/deploy-q2.sh <tag|sha>. Er REF eksportert fra annet arbeid: unset REF)
endif

# `make deploy-q2 <sha>` gjør <sha> til et mål nummer to. make ville deployet
# main først og feilet på <sha> etterpå, så ukjente mål stopper før noe kjører.
UKJENTE_MAL := $(filter-out help deploy-q2 deploy-q2-sjekk,$(MAKECMDGOALS))
ifneq ($(UKJENTE_MAL),)
$(error ukjent mål: $(UKJENTE_MAL). make-målene tar ingen ref. For en bestemt ref: scripts/deploy-q2.sh <tag|sha>)
endif

help:
	@echo "make deploy-q2        deployer tuppen av muninn main til q2"
	@echo "make deploy-q2-sjekk  bare forhåndssjekkene, starter ingen workflow"
	@echo "scripts/deploy-q2.sh <tag|sha>            deployer en bestemt ref"
	@echo "DRY_RUN=1 scripts/deploy-q2.sh <tag|sha>  sjekker en bestemt ref"

deploy-q2:
	@scripts/deploy-q2.sh

deploy-q2-sjekk:
	@DRY_RUN=1 scripts/deploy-q2.sh
